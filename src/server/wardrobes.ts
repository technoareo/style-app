import { backupSchema } from "../domain/backup";
import { getDatabase } from "./database";
import { RequestError } from "./access";
import { isSqliteBusy, retryBusy } from "./sqliteRetry";
import {
  inTransaction,
  runWriteTransaction,
  WriteContentionError,
} from "./writeTransaction";

/**
 * Wardrobe repository.
 *
 * Read path (build 015): {@link readWardrobe} is a plain read. It takes neither
 * the process write gate nor BEGIN IMMEDIATE, so ordinary reads no longer queue
 * behind registration, worker leases or other writers. Photo reclamation is a
 * separate, bounded, best-effort write ({@link reclaimExpiredPhotos}) that is
 * scheduled only when the read saw an expired photo no wardrobe references. It
 * never trusts that read: it re-reads the CURRENT wardrobe row inside its own
 * committing transaction, so a save that attached the photo in between keeps it.
 *
 * Save path: {@link prepareWardrobeSave} is pure (no database, no gate). The
 * photo existence/ownership checks, the optimistic revision check, the
 * idempotent acknowledgement, the write and the old/current reclamation all
 * stay together in {@link commitWardrobeSave}, inside one transaction.
 */

/** Unreferenced photos are reclaimed once they are older than this. */
export const PHOTO_GRACE_MS = 86_400_000;
/** Budget for one best-effort reclamation (gate wait plus SQLite lock). */
export const RECLAIM_ACQUIRE_MS = 2_000;
/** Budget for the lock-free read when SQLite reports a transient busy. */
const READ_RETRY_MS = 2_000;
/** Fixed answer for a stored wardrobe that cannot be read; reveals nothing. */
const UNREADABLE_WARDROBE =
  "Your saved wardrobe could not be read. Nothing was changed. Please contact support.";

const pathId = (path: string) =>
  /^\/api\/photos\/([a-zA-Z0-9-]{1,100})$/.exec(path)?.[1];
type PhotoSpace = {
  wardrobe: { image: string; sourcePhoto?: string }[];
  looks: { items: { image: string; sourcePhoto?: string }[] }[];
};
const references = (data: PhotoSpace) =>
  new Set(
    [...data.wardrobe, ...data.looks.flatMap((l) => l.items)]
      .flatMap((g) => [g.image, g.sourcePhoto || ""])
      .map(pathId)
      .filter((id): id is string => Boolean(id)),
  );

/**
 * Stored references, or null when the stored document does not have the shape
 * of a wardrobe. Reclamation treats null as "do not delete anything": an
 * unreadable document must never look like "nothing is referenced".
 */
function shapedReferences(value: unknown): Set<string> | null {
  try {
    const data = value as Partial<PhotoSpace> | null;
    if (
      !data ||
      !Array.isArray(data.wardrobe) ||
      !Array.isArray(data.looks) ||
      data.looks.some((l) => !l || !Array.isArray(l.items))
    )
      return null;
    return references(data as PhotoSpace);
  } catch {
    return null;
  }
}
function storedReferences(dataJson: string): Set<string> | null {
  try {
    return shapedReferences(JSON.parse(dataJson));
  } catch {
    return null;
  }
}

/**
 * Deletes this user's photos that `keep` does not reference and that are
 * either listed in `old` (referenced by the replaced document) or older than
 * the grace period. Must run inside the caller's committing transaction.
 */
function reclaimPhotos(
  userId: string,
  keep: ReadonlySet<string>,
  old: ReadonlySet<string>,
  now: number,
): number {
  const db = getDatabase();
  const assets = db
    .prepare("SELECT id,created_at FROM photo_assets WHERE user_id=?")
    .all(userId) as { id: string; created_at: number }[];
  const remove = db.prepare(
    "DELETE FROM photo_assets WHERE id=? AND user_id=?",
  );
  let removed = 0;
  for (const asset of assets)
    if (
      !keep.has(asset.id) &&
      (old.has(asset.id) || asset.created_at < now - PHOTO_GRACE_MS)
    ) {
      remove.run(asset.id, userId);
      removed++;
    }
  return removed;
}

export type WardrobeView = {
  version?: number;
  name?: string;
  wardrobe: unknown[];
  looks: unknown[];
  revision: number;
  [key: string]: unknown;
};

export type WardrobeRead = {
  wardrobe: WardrobeView;
  /**
   * A HINT, not an authorization to delete: this read saw an expired photo
   * that the document it returned does not reference. The reclamation that
   * acts on it re-reads the current document first.
   */
  reclaimable: boolean;
};

/**
 * Lock-free read. No write gate, no BEGIN, no write. A user with no stored
 * wardrobe gets revision 0 and NO row is created. Synchronous: it does not
 * wait for any lock, so it can run inside or outside a transaction.
 */
export function readWardrobe(
  userId: string,
  name: string,
  now: number = Date.now(),
): WardrobeRead {
  const db = getDatabase();
  const row = db
    .prepare("SELECT revision,data_json FROM wardrobe_spaces WHERE user_id=?")
    .get(userId) as { revision: number; data_json: string } | undefined;
  let stored: Record<string, unknown> | undefined;
  let kept = new Set<string>();
  if (row) {
    // A stored document that is not JSON or not shaped like a wardrobe is
    // answered with one fixed 500. It is never repaired, never replaced by an
    // empty wardrobe and never echoed: the account's data stays untouched.
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data_json);
    } catch {
      parsed = undefined;
    }
    const shaped = shapedReferences(parsed);
    if (shaped === null) throw new RequestError(500, UNREADABLE_WARDROBE);
    stored = parsed as Record<string, unknown>;
    kept = shaped;
  }
  const wardrobe: WardrobeView = stored
    ? ({ ...stored, revision: row!.revision } as WardrobeView)
    : { version: 1, name, wardrobe: [], looks: [], revision: 0 };
  const expired = db
    .prepare("SELECT id FROM photo_assets WHERE user_id=? AND created_at<?")
    .all(userId, now - PHOTO_GRACE_MS) as { id: string }[];
  const reclaimable = expired.some((a) => !kept.has(a.id));
  return { wardrobe, reclaimable };
}

/** {@link readWardrobe} that retries a transient SQLITE_BUSY asynchronously. */
export async function readWardrobeAsync(
  userId: string,
  name: string,
): Promise<WardrobeRead> {
  try {
    return await retryBusy(() => readWardrobe(userId, name), {
      timeoutMs: READ_RETRY_MS,
    });
  } catch (error) {
    // A read that still cannot proceed is the same retryable 503 as a refused
    // write lock.
    if (isSqliteBusy(error)) throw new WriteContentionError();
    throw error;
  }
}

/**
 * Deletes this user's expired photos that the CURRENT wardrobe does not
 * reference. Synchronous body: it must run inside a committing write
 * transaction (it joins one via inTransaction), and it re-reads the wardrobe
 * row itself. Never pass it references captured by an earlier read.
 */
export function reclaimExpiredPhotosInTransaction(
  userId: string,
  now: number = Date.now(),
): number {
  const db = getDatabase();
  return inTransaction(db, () => {
    const row = db
      .prepare("SELECT data_json FROM wardrobe_spaces WHERE user_id=?")
      .get(userId) as { data_json: string } | undefined;
    // No row: nothing is referenced and none is created. A row that cannot be
    // read as a wardrobe fails closed.
    const keep = row ? storedReferences(row.data_json) : new Set<string>();
    if (keep === null) return 0;
    return reclaimPhotos(userId, keep, new Set<string>(), now);
  });
}

/** One bounded write transaction; rejects like any write if the budget runs out. */
export function reclaimExpiredPhotos(
  userId: string,
  options: { acquireTimeoutMs?: number; now?: number } = {},
): Promise<number> {
  return runWriteTransaction(
    () => reclaimExpiredPhotosInTransaction(userId, options.now),
    { acquireTimeoutMs: options.acquireTimeoutMs ?? RECLAIM_ACQUIRE_MS },
  );
}

const inflight = new Map<string, Promise<void>>();

/**
 * Best-effort reclamation after a read. At most one per user at a time (a
 * concurrent caller joins the one in flight), bounded by RECLAIM_ACQUIRE_MS,
 * and every failure is swallowed: the read's answer does not depend on it, and
 * the next read that still sees an expired photo simply asks again.
 */
export function reclaimAfterRead(userId: string): Promise<void> {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const run = reclaimExpiredPhotos(userId)
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      inflight.delete(userId);
    });
  inflight.set(userId, run);
  return run;
}

/**
 * Compatibility for direct callers: the original synchronous read-and-reclaim
 * in one transaction (it joins the caller's, or opens its own). The route no
 * longer uses it, so it is the only path that still takes the write lock for a
 * read.
 */
export function loadWardrobe(userId: string, name: string) {
  const db = getDatabase();
  return inTransaction(db, () => {
    const { wardrobe } = readWardrobe(userId, name);
    reclaimExpiredPhotosInTransaction(userId);
    return wardrobe;
  });
}

/**
 * Public, read-only view of a prepared save. It is an INFORMATIONAL handle:
 * {@link commitWardrobeSave} never trusts these fields. It looks the object up
 * (by identity) in a registry private to this module and uses the payload
 * stored there, so a hand-built, cloned, spread or Proxy-wrapped object is
 * refused before any database access. The object and both arrays are frozen.
 */
export type PreparedWardrobeSave = {
  /** Revision the client based its edit on (validated shape only). */
  readonly revision: number;
  /** Canonical serialized document, at most 3 MB. */
  readonly json: string;
  /** Photo ids the document references. */
  readonly references: readonly string[];
  /**
   * Distinct photo ids that must exist and belong to the caller. Only the
   * transaction can decide that.
   */
  readonly photoIds: readonly string[];
};

type PreparedPayload = {
  readonly revision: number;
  readonly json: string;
  readonly references: ReadonlySet<string>;
  readonly photoIds: readonly string[];
};

/**
 * Objects issued by prepareWardrobeSave, mapped to the payload the commit
 * trusts. Not exported, so no other module can add an entry. The payload is
 * built once from the one validated parse (json, references and photoIds come
 * from the same value), so the commit needs no JSON.parse and no re-derivation
 * inside the write hold, and nothing a caller can reach is ever consulted.
 */
const issued = new WeakMap<object, PreparedPayload>();

/**
 * Pure preparation: schema, revision shape, photo-string syntax, serialization
 * and reference enumeration. Touches no database and takes no lock, so it can
 * run before the write gate is requested. Throws the same RequestErrors as the
 * original saveWardrobe, except that a document that is both oversize and has
 * an unavailable photo now reports 413 first. The result is the only thing
 * {@link commitWardrobeSave} accepts. It is not bound to an account (this
 * function does not know one), so the same prepared save may be committed again
 * for idempotent retries; ownership is always checked against the committing
 * account.
 */
export function prepareWardrobeSave(input: unknown): PreparedWardrobeSave {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success)
    throw new RequestError(400, "Check your wardrobe details before saving.");
  const revision = (input as { revision?: unknown }).revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new RequestError(400, "Missing wardrobe version.");
  // Validation only: ownership ids are NOT collected here. They are derived
  // below from the same reference set the reclamation uses, so the two can
  // never diverge.
  const checkPhoto = (image: string) => {
    if (pathId(image)) return;
    if (
      image.startsWith("data:") ||
      image.length > 40 ||
      /^https?:|^\/|<|>/.test(image)
    )
      throw new RequestError(
        400,
        "Upload photos to your account before saving.",
      );
  };
  for (const item of [
    ...parsed.data.wardrobe,
    ...parsed.data.looks.flatMap((l) => l.items),
  ]) {
    checkPhoto(item.image);
    if (item.sourcePhoto) checkPhoto(item.sourcePhoto);
  }
  const json = JSON.stringify(parsed.data);
  if (Buffer.byteLength(json) > 3_000_000)
    throw new RequestError(
      413,
      "Your wardrobe is too large. Export a backup and remove unused looks.",
    );
  const referenceSet = references(parsed.data);
  const photoIds = Object.freeze([...referenceSet]);
  const payload: PreparedPayload = Object.freeze({
    revision,
    json,
    references: referenceSet,
    photoIds,
  });
  // The public object has its own frozen arrays: freezing a Set would not stop
  // add()/delete(), so no Set is ever handed out.
  const prepared: PreparedWardrobeSave = Object.freeze({
    revision,
    json,
    references: Object.freeze([...referenceSet]),
    photoIds: Object.freeze([...referenceSet]),
  });
  issued.set(prepared, payload);
  return prepared;
}

/**
 * The atomic part of a save. Everything that depends on database state is
 * here, in one transaction (it joins the caller's runWriteTransaction, or
 * opens its own): photo existence and ownership for THIS user, the revision
 * comparison, the idempotent acknowledgement, the upsert and reclamation of
 * photos the replaced and current documents no longer reference. No await.
 *
 * Throws TypeError, before touching the database, for anything that
 * prepareWardrobeSave did not issue (forged, cloned, spread or proxied).
 */
export function commitWardrobeSave(
  userId: string,
  prepared: PreparedWardrobeSave,
) {
  const payload =
    prepared !== null && typeof prepared === "object"
      ? issued.get(prepared)
      : undefined;
  if (!payload) throw new TypeError("Wardrobe save was not prepared.");
  const { revision, json } = payload;
  const db = getDatabase();
  return inTransaction(db, () => {
    const owns = db.prepare(
      "SELECT id FROM photo_assets WHERE id=? AND user_id=?",
    );
    for (const id of payload.photoIds)
      if (!owns.get(id, userId))
        throw new RequestError(400, "A wardrobe photo is unavailable.");
    const row = db
      .prepare("SELECT revision,data_json FROM wardrobe_spaces WHERE user_id=?")
      .get(userId) as { revision: number; data_json: string } | undefined;
    if ((row?.revision ?? 0) !== revision) {
      // A response may be lost after commit. A byte-identical desired state
      // is safe to acknowledge; different stale edits still conflict.
      if (row?.data_json === json) return { revision: row.revision };
      throw new RequestError(
        409,
        "Your wardrobe changed on another device. Export your unsaved changes, then reload before editing again.",
      );
    }
    db.prepare(
      "INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
    ).run(userId, revision + 1, json);
    // The replaced document is read here, inside the transaction, so the
    // reclaimed set always reflects what was current when this save committed.
    // One that cannot be read (not JSON, not wardrobe-shaped) contributes an
    // empty set: the document being saved is authoritative for `keep`, and the
    // 24 h grace sweep still applies. The save is not blocked by corruption.
    const old = (row && storedReferences(row.data_json)) || new Set<string>();
    reclaimPhotos(userId, payload.references, old, Date.now());
    return { revision: revision + 1 };
  });
}

/** Compatibility for direct callers: prepare, then commit. */
export function saveWardrobe(userId: string, input: unknown) {
  return commitWardrobeSave(userId, prepareWardrobeSave(input));
}
