// FIRST import: sets STYLE_DATA_DIR and APP_URL (and clears SMTP_URL) before
// any src/ module is evaluated; see tests/helpers/wardrobeEnv.ts.
import "./helpers/wardrobeEnv";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RequestError } from "../src/server/access";
import { closeDatabases, getDatabase } from "../src/server/database";
import { settleLocalCapture } from "../src/server/mailOutbox";
import {
  commitWardrobeSave,
  loadWardrobe,
  prepareWardrobeSave,
  readWardrobe,
  readWardrobeAsync,
  reclaimAfterRead,
  reclaimExpiredPhotos,
  reclaimExpiredPhotosInTransaction,
  saveWardrobe,
  type PreparedWardrobeSave,
} from "../src/server/wardrobes";
import { runWriteTransaction } from "../src/server/writeTransaction";
import {
  acquireWriteGate,
  WriteGateError,
  writeGateQueueLength,
} from "../src/server/writeGate";
import {
  DAY,
  addPhoto,
  bareGarment,
  dataDir,
  garment,
  look,
  newRepositoryUser,
  newUser,
  outboxRows,
  oversizeDocument,
  photoExists,
  putRawRow,
  space,
  storedRow,
  wardrobeRows,
} from "./helpers/wardrobeFixtures";

/**
 * Build 015: wardrobe read-first path and prepare/commit save split.
 *
 * Written, not executed by the author (no shell in that session). Where a race
 * is needed it is made deterministic by holding the process write gate, so the
 * interleaving is fixed by the test and not by timers: a reclamation that is
 * queued behind the gate cannot start until the test releases it.
 * Route-level tests (real GET/PUT handlers) are in wardrobeRoutes015.test.ts.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let holder: DatabaseSync | undefined;

after(() => {
  if (holder?.isOpen) {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
  closeDatabases();
});

const rejectsWith = (status: number) => (error: unknown) =>
  error instanceof RequestError && error.status === status;

test("an ordinary read takes neither the write gate nor the SQLite write lock, and a missing wardrobe stays revision 0 without a row", async () => {
  const alice = await newRepositoryUser("read-first");
  getDatabase(); // warm
  const other = (holder ??= new DatabaseSync(path.join(dataDir, "app.db"), {
    timeout: 1,
  }));
  other.exec("BEGIN IMMEDIATE"); // "another process" owns the write lock
  const release = await acquireWriteGate(); // and this process's gate is held
  try {
    const outcome = await Promise.race([
      readWardrobeAsync(alice, "Alice"),
      sleep(3000).then(() => "blocked" as const),
    ]);
    assert.notEqual(outcome, "blocked", "the read did not wait for the gate or the lock");
    const read = outcome as Awaited<ReturnType<typeof readWardrobeAsync>>;
    assert.equal(read.wardrobe.revision, 0);
    assert.equal(read.wardrobe.name, "Alice");
    assert.deepEqual(read.wardrobe.wardrobe, []);
    assert.deepEqual(read.wardrobe.looks, []);
    assert.equal(read.reclaimable, false, "nothing expired, nothing to reclaim");
    assert.equal(writeGateQueueLength(), 0, "the read never queued");
    assert.equal(getDatabase().isTransaction, false);
  } finally {
    release();
    other.exec("ROLLBACK");
  }
  assert.equal(wardrobeRows(alice), 0, "reading did not create a wardrobe row");
});

test("STATIC (supplementary text check, not runtime evidence; the real handlers are exercised in wardrobeRoutes015.test.ts): the wardrobe GET handler does not use the write path; PUT prepares before it acquires", () => {
  const source = readFileSync("src/app/api/wardrobe/route.ts", "utf8");
  const get = source.slice(
    source.indexOf("export async function GET"),
    source.indexOf("export async function PUT"),
  );
  const put = source.slice(source.indexOf("export async function PUT"));
  assert.ok(get.length > 50 && put.length > 50, "both handlers were located");
  assert.doesNotMatch(get, /runWriteTransaction|loadWardrobe|withWriteGate|acquireWriteGate/);
  assert.match(get, /readWardrobeAsync/);
  const prepared = put.indexOf("prepareWardrobeSave(");
  const acquired = put.indexOf("runWriteTransaction(");
  assert.ok(prepared > 0 && acquired > prepared, "validation and serialization precede the gate");
  assert.ok(put.indexOf("account(req, true)") < put.indexOf("readJson("), "authorization still precedes the body");
  assert.ok(put.indexOf("readJson(") < prepared);
});

test("reclamation re-reads the CURRENT wardrobe inside its committing transaction: a save that attaches the photo after the read keeps it", async () => {
  const alice = await newRepositoryUser("race");
  const attached = addPhoto(alice, 2 * DAY);
  const young = addPhoto(alice, 1000);

  // The read sees an expired photo no wardrobe references (a hint, nothing deleted).
  const snapshot = readWardrobe(alice, "Alice");
  assert.equal(snapshot.reclaimable, true);
  assert.equal(snapshot.wardrobe.revision, 0);
  assert.ok(photoExists(attached));

  // Hold the gate so the reclamation queues behind it BEFORE it starts.
  const release = await acquireWriteGate();
  const reclaim = reclaimExpiredPhotos(alice, { acquireTimeoutMs: 10_000 });
  let lateOrphan = "";
  try {
    await sleep(25);
    assert.equal(writeGateQueueLength(), 1, "the reclamation is waiting for the gate");
    // A concurrent save commits meanwhile and attaches `attached`.
    const saved = commitWardrobeSave(alice, prepareWardrobeSave(space(0, attached)));
    assert.deepEqual(saved, { revision: 1 });
    // A photo that is expired and unreferenced in the CURRENT document, to
    // show the reclamation still deletes what it should.
    lateOrphan = addPhoto(alice, 2 * DAY);
  } finally {
    release();
  }
  assert.equal(await reclaim, 1, "only the photo no current wardrobe references was reclaimed");
  assert.ok(photoExists(attached), "the photo the concurrent save attached survives");
  assert.equal(photoExists(lateOrphan), false, "the expired unreferenced photo is gone");
  assert.ok(photoExists(young), "photos inside the grace period are never reclaimed");
  assert.equal(wardrobeRows(alice), 1);
});

test("a missing wardrobe is reclaimed without creating a row; an unreadable stored document fails closed", async () => {
  const carol = await newRepositoryUser("missing");
  const old = addPhoto(carol, 3 * DAY);
  assert.equal(readWardrobe(carol, "Carol").reclaimable, true);
  assert.equal(await reclaimExpiredPhotos(carol), 1);
  assert.equal(photoExists(old), false);
  assert.equal(wardrobeRows(carol), 0, "reclamation never creates a wardrobe row");

  const dave = await newRepositoryUser("unreadable");
  const keep = addPhoto(dave, 3 * DAY);
  const db = getDatabase();
  for (const broken of ["{}", "not json", '{"wardrobe":[],"looks":[{}]}', "null"]) {
    db.prepare(
      "INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data_json=excluded.data_json",
    ).run(dave, 3, broken);
    assert.equal(
      reclaimExpiredPhotosInTransaction(dave),
      0,
      `unreadable document ${JSON.stringify(broken)} deletes nothing`,
    );
    assert.ok(photoExists(keep));
  }
});

test("a reclamation that cannot start inside its budget fails retryably and deletes nothing; the same call works afterwards", async () => {
  const erin = await newRepositoryUser("budget");
  const old = addPhoto(erin, 2 * DAY);
  const release = await acquireWriteGate();
  try {
    await assert.rejects(
      reclaimExpiredPhotos(erin, { acquireTimeoutMs: 80 }),
      (error: unknown) => error instanceof WriteGateError,
    );
  } finally {
    release();
  }
  assert.ok(photoExists(old));
  assert.equal(writeGateQueueLength(), 0, "the timed-out waiter left the queue");
  // The route-level helper never throws, and concurrent callers share one run.
  const [a, b] = [reclaimAfterRead(erin), reclaimAfterRead(erin)];
  assert.equal(a, b, "one in-flight reclamation per account");
  await a;
  assert.equal(photoExists(old), false);
});

test("reads see the same shape as before, and the legacy loadWardrobe still reads and reclaims in one transaction", async () => {
  const frank = await newRepositoryUser("legacy");
  const keep = addPhoto(frank, 2 * DAY);
  assert.deepEqual(saveWardrobe(frank, space(0, keep)), { revision: 1 });
  const old = addPhoto(frank, 2 * DAY); // expired, unreferenced, added after the save
  const loaded = loadWardrobe(frank, "Frank");
  assert.equal(loaded.revision, 1);
  assert.equal((loaded.wardrobe as unknown[]).length, 1);
  assert.equal(photoExists(old), false, "legacy load still reclaims");
  assert.ok(photoExists(keep));
  const read = readWardrobe(frank, "Frank");
  assert.deepEqual(read.wardrobe, loaded);
  assert.equal(read.reclaimable, false, "every expired photo is referenced");
  assert.equal(getDatabase().isTransaction, false);
});

test("prepareWardrobeSave is pure: it validates, enumerates references and serializes without the database or gate", async () => {
  const release = await acquireWriteGate(); // would block anything that queued
  try {
    const prepared = prepareWardrobeSave({
      ...space(4, "aaa", "bbb"),
      looks: [],
    });
    assert.equal(prepared.revision, 4);
    assert.deepEqual([...prepared.photoIds].sort(), ["aaa", "bbb"]);
    assert.deepEqual([...prepared.references].sort(), ["aaa", "bbb"]);
    assert.equal(JSON.parse(prepared.json).revision, undefined, "revision is not part of the stored document");
    assert.equal(writeGateQueueLength(), 0);
    assert.throws(() => prepareWardrobeSave({ ...space(0), wardrobe: "nope" }), rejectsWith(400));
    const noRevision = { ...space(0) } as Partial<ReturnType<typeof space>>;
    delete noRevision.revision;
    assert.throws(() => prepareWardrobeSave(noRevision), rejectsWith(400));
    for (const bad of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 2])
      assert.throws(
        () => prepareWardrobeSave({ ...space(0), revision: bad }),
        rejectsWith(400),
        `revision ${String(bad)}`,
      );
    const inline = space(0, "aaa");
    inline.wardrobe[0].image = "data:image/png;base64,AAAA";
    assert.throws(() => prepareWardrobeSave(inline), rejectsWith(400));
    const external = space(0, "aaa");
    external.wardrobe[0].image = "https://example.test/x.jpg";
    assert.throws(() => prepareWardrobeSave(external), rejectsWith(400));
  } finally {
    release();
  }
});

test("everything that depends on database state is decided at commit time, in the transaction", async () => {
  const gina = await newRepositoryUser("commit-a");
  const hank = await newRepositoryUser("commit-b");
  const mine = addPhoto(gina, 1000);
  const theirs = addPhoto(hank, 1000);

  // Ownership: another account's photo and a nonexistent photo are refused.
  assert.throws(
    () => commitWardrobeSave(gina, prepareWardrobeSave(space(0, theirs))),
    rejectsWith(400),
  );
  assert.throws(
    () => commitWardrobeSave(gina, prepareWardrobeSave(space(0, "no-such-photo"))),
    rejectsWith(400),
  );
  assert.equal(wardrobeRows(gina), 0, "a refused save writes nothing");

  // Prepared early, photo removed before commit: the stale preparation is not trusted.
  const early = prepareWardrobeSave(space(0, mine));
  getDatabase().prepare("DELETE FROM photo_assets WHERE id=?").run(mine);
  assert.throws(() => commitWardrobeSave(gina, early), rejectsWith(400));
  const mine2 = addPhoto(gina, 1000);

  // Revision: prepared at 0, but another save lands first.
  const stale = prepareWardrobeSave(space(0, mine2));
  const first = await runWriteTransaction(() =>
    commitWardrobeSave(gina, prepareWardrobeSave({ ...space(0, mine2), name: "Other device" })),
  );
  assert.deepEqual(first, { revision: 1 });
  assert.throws(() => commitWardrobeSave(gina, stale), rejectsWith(409));

  // Idempotent acknowledgement: the byte-identical document is acknowledged,
  // not rewritten (the revision stays 1).
  const same = prepareWardrobeSave({ ...space(0, mine2), name: "Other device" });
  assert.deepEqual(commitWardrobeSave(gina, same), { revision: 1 });
  assert.equal(readWardrobe(gina, "G").wardrobe.revision, 1);

  // A matching revision writes and advances.
  const next = prepareWardrobeSave({ ...space(1, mine2), name: "Third" });
  assert.deepEqual(await runWriteTransaction(() => commitWardrobeSave(gina, next)), { revision: 2 });

  // Reclamation inside the save: removing the last reference deletes the
  // asset (replaced document), an old unreferenced photo goes, a young one stays.
  const oldOrphan = addPhoto(gina, 2 * DAY);
  const youngOrphan = addPhoto(gina, 500);
  assert.deepEqual(
    commitWardrobeSave(gina, prepareWardrobeSave({ ...space(2), name: "Empty" })),
    { revision: 3 },
  );
  assert.equal(photoExists(mine2), false, "the replaced document's photo is reclaimed");
  assert.equal(photoExists(oldOrphan), false);
  assert.ok(photoExists(youngOrphan));
  assert.ok(photoExists(theirs), "another account's photo is never touched");
});

test("saveWardrobe keeps its direct-caller behaviour (prepare then commit in one call)", async () => {
  const ivy = await newRepositoryUser("direct");
  const p = addPhoto(ivy, 100);
  assert.deepEqual(saveWardrobe(ivy, space(0, p)), { revision: 1 });
  assert.deepEqual(saveWardrobe(ivy, space(0, p)), { revision: 1 }, "identical retry");
  assert.throws(() => saveWardrobe(ivy, { ...space(0, p), name: "different" }), rejectsWith(409));
  assert.throws(() => saveWardrobe(ivy, "garbage"), rejectsWith(400));
});

// ---------------------------------------------------------------------------
// Revision 2 (after the independent review): F1 unforgeable prepared saves,
// F2 reference coverage, F6 malformed stored documents, oversize precedence.
// Written, not executed.
// ---------------------------------------------------------------------------

/**
 * Runs `fn` (synchronously) while another connection owns SQLite's write lock.
 * Anything in `fn` that reached `BEGIN IMMEDIATE` would fail with SQLITE_BUSY
 * instead of the error the test expects, which proves "no database access".
 */
function withForeignWriteLock<T>(fn: () => T): T {
  getDatabase(); // warm the main connection first
  const other = (holder ??= new DatabaseSync(path.join(dataDir, "app.db"), {
    timeout: 1,
  }));
  other.exec("BEGIN IMMEDIATE");
  try {
    return fn();
  } finally {
    other.exec("ROLLBACK");
  }
}
const isTypeError = (error: unknown) => error instanceof TypeError;
const mutable = (value: object) => value as Record<string, unknown>;
const attempt = (fn: () => void) => {
  try {
    fn();
  } catch {
    // frozen: ignored (sloppy mode) or refused (strict mode); either is fine
  }
};

test("F1: forged, cloned, spread, derived, proxied and non-object saves are refused before any database access, and a real one still commits", async () => {
  const gina = await newRepositoryUser("forge-a");
  const hank = await newRepositoryUser("forge-b");
  const mine = addPhoto(gina, 2 * DAY);
  const theirs = addPhoto(hank, 2 * DAY);
  const real = prepareWardrobeSave(space(0, mine));
  const forgedJson = JSON.stringify({
    version: 1,
    name: "Forged",
    wardrobe: space(0, theirs).wardrobe,
    looks: [],
  });
  const candidates: [string, unknown][] = [
    ["hand-built with no photoIds", { revision: 0, json: forgedJson, references: [], photoIds: [] }],
    ["hand-built with a Set", { revision: 0, json: forgedJson, references: new Set<string>(), photoIds: [] }],
    ["spread copy of a real one", { ...real }],
    ["structuredClone of a real one", structuredClone(real)],
    ["JSON round trip of a real one", JSON.parse(JSON.stringify(real))],
    ["prototype-derived from a real one", Object.create(real)],
    ["Proxy around a real one", new Proxy(real, {})],
    ["null", null],
    ["undefined", undefined],
    ["a string", "prepared"],
    ["a number", 7],
    ["an array", []],
  ];
  withForeignWriteLock(() => {
    for (const [label, candidate] of candidates)
      assert.throws(
        () => commitWardrobeSave(gina, candidate as PreparedWardrobeSave),
        isTypeError,
        `${label}: refused with TypeError, not reaching BEGIN IMMEDIATE`,
      );
  });
  assert.equal(wardrobeRows(gina), 0);
  assert.equal(wardrobeRows(hank), 0);
  assert.ok(photoExists(mine) && photoExists(theirs), "no photo was touched");
  assert.equal(getDatabase().isTransaction, false);
  assert.deepEqual(commitWardrobeSave(gina, real), { revision: 1 }, "the genuine object is unaffected");
  assert.ok(photoExists(mine));
});

test("F1: an issued save is frozen with real frozen arrays, and attempts to mutate it cannot change what is committed", async () => {
  const gina = await newRepositoryUser("mutate-a");
  const hank = await newRepositoryUser("mutate-b");
  const mine = addPhoto(gina, 2 * DAY); // older than the grace period
  const theirs = addPhoto(hank, 1000);

  const foreign = prepareWardrobeSave(space(0, theirs));
  assert.ok(Object.isFrozen(foreign), "the object is frozen");
  assert.ok(Object.isFrozen(foreign.photoIds), "photoIds is a frozen array");
  assert.ok(Object.isFrozen(foreign.references), "references is a frozen array");
  assert.ok(Array.isArray(foreign.references), "references is an array, not a Set (a frozen Set can still be mutated)");
  assert.ok(!((foreign.references as unknown) instanceof Set));
  assert.throws(() => (foreign.photoIds as string[]).push("x"), TypeError);
  assert.throws(() => (foreign.photoIds as string[]).splice(0), TypeError);
  assert.throws(() => (foreign.references as string[]).pop(), TypeError);
  attempt(() => void (mutable(foreign).photoIds = []));
  attempt(() => void (mutable(foreign).references = []));
  attempt(() => void (mutable(foreign).revision = 99));
  attempt(() => void (mutable(foreign).json = "{}"));
  attempt(() => void Object.defineProperty(foreign, "photoIds", { value: [] }));
  assert.deepEqual([...foreign.photoIds], [theirs]);
  // The ownership list the commit uses is not reachable from the object, so
  // whatever the attempts above did, another account's photo is still refused.
  assert.throws(() => commitWardrobeSave(gina, foreign), rejectsWith(400));
  assert.equal(wardrobeRows(gina), 0);

  // Emptying `references` cannot turn a save into a mass delete: the document
  // being saved still protects its own (expired) photo.
  const own = prepareWardrobeSave(space(0, mine));
  const originalJson = own.json;
  attempt(() => void (mutable(own).references = []));
  attempt(() => void (mutable(own).photoIds = []));
  attempt(() => void (mutable(own).json = JSON.stringify(space(0))));
  assert.deepEqual(commitWardrobeSave(gina, own), { revision: 1 });
  assert.ok(photoExists(mine), "the expired photo the saved document references survives");
  assert.equal(storedRow(gina)!.data_json, originalJson, "the canonical JSON that was prepared is the JSON stored");
  assert.ok(photoExists(theirs));
});

test("F1: ownership is decided for the committing account; reusing one prepared save is idempotent and harmless across accounts", async () => {
  const gina = await newRepositoryUser("reuse-a");
  const hank = await newRepositoryUser("reuse-b");
  const mine = addPhoto(gina, 1000);
  const hanksOld = addPhoto(hank, 2 * DAY);

  const prepared = prepareWardrobeSave(space(0, mine));
  assert.throws(() => commitWardrobeSave(hank, prepared), rejectsWith(400));
  assert.equal(wardrobeRows(hank), 0, "the other account stored nothing");
  assert.ok(photoExists(mine), "the first account's photo is untouched");
  assert.ok(photoExists(hanksOld), "the refused commit rolled back, so it reclaimed nothing");

  assert.deepEqual(commitWardrobeSave(gina, prepared), { revision: 1 });
  assert.deepEqual(commitWardrobeSave(gina, prepared), { revision: 1 }, "the same token again is the byte-identical acknowledgement");
  assert.equal(readWardrobe(gina, "G").wardrobe.revision, 1);

  // A document with no photos is legitimately reusable by any account.
  const ivy = await newRepositoryUser("reuse-c");
  const empty = prepareWardrobeSave({ ...space(0), name: "Shared shape" });
  assert.deepEqual(commitWardrobeSave(hank, empty), { revision: 1 });
  assert.deepEqual(commitWardrobeSave(ivy, empty), { revision: 1 }, "each account has its own revision counter");
  assert.equal(readWardrobe(hank, "H").wardrobe.revision, 1);
  assert.equal(readWardrobe(ivy, "I").wardrobe.revision, 1);
  assert.equal(readWardrobe(gina, "G").wardrobe.revision, 1, "gina's wardrobe was not touched");
});

type RefKind = {
  label: string;
  build: (photos: string[]) => { wardrobe: unknown[]; looks: unknown[] };
};
const refKinds: RefKind[] = [
  {
    label: "a saved look item's image only",
    build: (ps) => ({
      wardrobe: [],
      looks: [look(...ps.map((p, i) => garment(p, "Look item " + i)))],
    }),
  },
  {
    label: "a wardrobe item's sourcePhoto only",
    build: (ps) => ({
      wardrobe: ps.map((p, i) => bareGarment("Source " + i, p)),
      looks: [],
    }),
  },
  {
    label: "a saved look item's sourcePhoto only",
    build: (ps) => ({
      wardrobe: [],
      looks: [look(...ps.map((p, i) => bareGarment("Look source " + i, p)))],
    }),
  },
];
const refDocument = (kind: RefKind, revision: number, photos: string[]) => ({
  version: 1,
  name: "References",
  ...kind.build(photos),
  revision,
});

for (const kind of refKinds)
  test(`F2: a photo referenced by ${kind.label} survives a concurrent-save race and later cleanups, and is deleted when a save removes it`, async () => {
    const user = await newRepositoryUser("refs");
    const stranger = await newRepositoryUser("refs-other");
    const strangers = addPhoto(stranger, 2 * DAY);
    const aged = addPhoto(user, 2 * DAY); // past the grace period
    const young = addPhoto(user, 1000); // inside it

    // Deterministic race: the read sees `aged` unreferenced, the reclamation is
    // queued behind the held gate, and a save attaches both photos through
    // this reference kind before it can start.
    assert.equal(readWardrobe(user, "U").reclaimable, true);
    const release = await acquireWriteGate();
    const reclaim = reclaimExpiredPhotos(user, { acquireTimeoutMs: 10_000 });
    try {
      await sleep(25);
      assert.equal(writeGateQueueLength(), 1, "the reclamation is waiting for the gate");
      assert.deepEqual(
        commitWardrobeSave(user, prepareWardrobeSave(refDocument(kind, 0, [aged, young]))),
        { revision: 1 },
      );
    } finally {
      release();
    }
    assert.equal(await reclaim, 0, "this reference kind protected the photo");
    assert.ok(photoExists(aged) && photoExists(young));

    // Later cleanups: the hint ignores referenced photos; a real orphan goes.
    assert.equal(readWardrobe(user, "U").reclaimable, false, "every expired photo is referenced");
    const orphan = addPhoto(user, 2 * DAY);
    assert.equal(readWardrobe(user, "U").reclaimable, true);
    assert.equal(await reclaimExpiredPhotos(user), 1);
    assert.equal(photoExists(orphan), false);
    await reclaimAfterRead(user);
    assert.ok(photoExists(aged), "the referenced expired photo survives every cleanup");
    assert.ok(photoExists(young));

    // A save that removes the references deletes both: the replaced document's
    // references are honoured even for the photo still inside the grace period.
    assert.deepEqual(
      commitWardrobeSave(user, prepareWardrobeSave(refDocument(kind, 1, []))),
      { revision: 2 },
    );
    assert.equal(photoExists(aged), false, "removal-save deletes the expired photo");
    assert.equal(photoExists(young), false, "removal-save deletes the young photo too");
    assert.ok(photoExists(strangers), "another account's photo is never touched");
  });

const BROKEN_DOCUMENTS = [
  "not json",
  "{}",
  "null",
  "[]",
  '{"wardrobe":"x","looks":[]}',
  '{"wardrobe":[],"looks":[{}]}',
];

test("F6: a stored document that cannot be read answers one fixed 500 on read, is never repaired and never becomes an empty wardrobe", async () => {
  const user = await newRepositoryUser("broken-read");
  const expiredPhoto = addPhoto(user, 2 * DAY);
  const isFixed500 = (error: unknown) =>
    error instanceof RequestError &&
    error.status === 500 &&
    /could not be read/.test(error.message) &&
    !BROKEN_DOCUMENTS.some((d) => d.length > 3 && error.message.includes(d));
  for (const broken of BROKEN_DOCUMENTS) {
    putRawRow(user, 3, broken);
    assert.throws(() => readWardrobe(user, "U"), isFixed500, broken);
    await assert.rejects(readWardrobeAsync(user, "U"), isFixed500, broken);
    const row = storedRow(user)!;
    assert.equal(row.data_json, broken, "no automatic repair or replacement");
    assert.equal(row.revision, 3);
    assert.ok(photoExists(expiredPhoto), "an unreadable document reclaims nothing");
  }
});

test("F6: a save over an unreadable replaced document succeeds with an empty old set, keeps the current references, still applies the 24 h grace, and keeps its revision and ownership checks", async () => {
  for (const broken of BROKEN_DOCUMENTS) {
    const user = await newRepositoryUser("broken-save");
    const stranger = await newRepositoryUser("broken-save-other");
    const strangers = addPhoto(stranger, 2 * DAY);
    const mine = addPhoto(user, 2 * DAY);
    const oldOrphan = addPhoto(user, 2 * DAY);
    const young = addPhoto(user, 500);
    putRawRow(user, 3, broken);

    // Revision check still applies and changes nothing.
    assert.throws(() => saveWardrobe(user, space(2, mine)), rejectsWith(409), broken);
    assert.equal(storedRow(user)!.data_json, broken);
    // Ownership still applies, and the refusal rolls everything back.
    assert.throws(() => saveWardrobe(user, space(3, strangers)), rejectsWith(400), broken);
    assert.equal(storedRow(user)!.data_json, broken);
    assert.ok(photoExists(oldOrphan), "a refused save reclaimed nothing");

    // The matching revision writes over the unreadable document.
    assert.deepEqual(saveWardrobe(user, space(3, mine)), { revision: 4 }, broken);
    assert.ok(photoExists(mine), "the current document's photo is kept");
    assert.equal(photoExists(oldOrphan), false, "the 24 h grace sweep still applies");
    assert.ok(photoExists(young), "a photo inside the grace period stays");
    assert.ok(photoExists(strangers));
    assert.equal(readWardrobe(user, "U").wardrobe.revision, 4, "readable again after the save");
  }
});

test("F6: the corrupt-document read refusal never deletes through loadWardrobe either", async () => {
  const user = await newRepositoryUser("broken-legacy");
  const expiredPhoto = addPhoto(user, 2 * DAY);
  putRawRow(user, 1, "not json");
  assert.throws(
    () => loadWardrobe(user, "U"),
    (error: unknown) => error instanceof RequestError && error.status === 500,
  );
  assert.ok(photoExists(expiredPhoto));
  assert.equal(storedRow(user)!.data_json, "not json");
  assert.equal(getDatabase().isTransaction, false, "no transaction was left open");
});

test("an oversize document that also references an unavailable photo answers 413 from the pure step, without any database access; a small one is refused later with 400", async () => {
  const user = await newRepositoryUser("oversize");
  const doc = oversizeDocument("no-such-photo-anywhere");
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) > 3_000_000, "precondition: over the 3 MB cap");
  withForeignWriteLock(() =>
    assert.throws(() => prepareWardrobeSave(doc), rejectsWith(413)),
  );
  assert.throws(() => saveWardrobe(user, doc), rejectsWith(413));
  assert.equal(wardrobeRows(user), 0);
  const small = { ...doc, looks: [], wardrobe: doc.wardrobe.slice(0, 2) };
  assert.throws(() => saveWardrobe(user, small), rejectsWith(400));
  assert.equal(wardrobeRows(user), 0);
});

// ---------------------------------------------------------------------------
// Revision 3 (after the corrected review): one photo referenced by two kinds,
// ownership ids derived from the reference set (L1), and the A/B/C writer
// diagnostic. Written, not executed.
// ---------------------------------------------------------------------------

test("one photo referenced by two kinds survives the removal of one reference and is reclaimed only when the last is removed", async () => {
  const user = await newRepositoryUser("two-kinds");
  const shared = addPhoto(user, 2 * DAY); // past the grace period
  const document = (revision: number, wardrobe: unknown[], looks: unknown[]) => ({
    version: 1,
    name: "Two kinds",
    wardrobe,
    looks,
    revision,
  });
  const bySource = () => [bareGarment("Source", shared)];
  const byLookImage = () => [look(garment(shared, "Look image"))];

  assert.deepEqual(
    commitWardrobeSave(user, prepareWardrobeSave(document(0, bySource(), byLookImage()))),
    { revision: 1 },
  );
  assert.ok(photoExists(shared));

  // Control: an expired orphan added afterwards proves reclamation really runs
  // in the saves below, so the survival of `shared` is not vacuous.
  const orphan = addPhoto(user, 2 * DAY);
  assert.deepEqual(
    commitWardrobeSave(user, prepareWardrobeSave(document(1, [], byLookImage()))),
    { revision: 2 },
  );
  assert.equal(photoExists(orphan), false, "the save ran reclamation");
  assert.ok(photoExists(shared), "still referenced by the saved look item's image");
  assert.equal(await reclaimExpiredPhotos(user), 0, "a later cleanup keeps it too");
  assert.ok(photoExists(shared));

  assert.deepEqual(
    commitWardrobeSave(user, prepareWardrobeSave(document(2, [], []))),
    { revision: 3 },
  );
  assert.equal(photoExists(shared), false, "removing the last reference reclaims it");
});

test("L1: ownership ids and reclamation references come from one set, for every reference shape", () => {
  const cases: [string, ReturnType<typeof space>][] = [
    ["wardrobe images", space(0, "aaa", "bbb")],
    [
      "duplicates across kinds",
      {
        ...space(0, "aaa"),
        wardrobe: [garment("aaa", "One", "aaa"), bareGarment("Two", "bbb")],
        looks: [look(garment("bbb", "L1", "ccc"), bareGarment("L2", "aaa"))],
      },
    ],
    ["no photos", space(0)],
    [
      "an empty image string",
      { ...space(0), wardrobe: [bareGarment("Bare")] },
    ],
  ];
  for (const [label, doc] of cases) {
    const prepared = prepareWardrobeSave(doc);
    assert.deepEqual(
      [...prepared.photoIds].sort(),
      [...prepared.references].sort(),
      label,
    );
    assert.equal(new Set(prepared.photoIds).size, prepared.photoIds.length, label);
  }
});

/**
 * One observation for the diagnostic: hold the gate, queue a reclamation, wait
 * a bounded 100 ms, record how many waiters the gate has and how many outbox
 * rows the account has. Counts only; no ids, bodies or SQL.
 */
async function observeGateQueue(userId: string) {
  addPhoto(userId, 2 * DAY);
  const outbox = outboxRows(userId);
  const release = await acquireWriteGate();
  const reclaim = reclaimExpiredPhotos(userId, { acquireTimeoutMs: 10_000 });
  let queue = -1;
  try {
    await sleep(100);
    queue = writeGateQueueLength();
  } finally {
    release();
  }
  await reclaim;
  return { queue, outbox };
}

test("DIAGNOSTIC A/B/C (not a release pass criterion, no substitute for the retention tests): which account setup puts a second writer behind the held gate", async (t) => {
  // A: direct row, no sign-up. Deterministic: nothing can queue besides the reclamation.
  const a = await observeGateQueue(await newRepositoryUser("diag-a"));
  t.diagnostic(`A direct row: queue=${a.queue}, account outbox rows=${a.outbox}`);
  assert.equal(a.outbox, 0);
  assert.equal(a.queue, 1, "A: only the reclamation waits");

  // B: real sign-up, NOT settled. Timing dependent by nature: reported, and
  // only bounded to the two values the hypothesis allows (1 if the drain had
  // already finished, 2 if its claim joined the queue).
  const b = await observeGateQueue(await newUser("diag-b"));
  t.diagnostic(`B real sign-up, unsettled: queue=${b.queue}, account outbox rows=${b.outbox}`);
  assert.ok(b.queue === 1 || b.queue === 2, `B observed an unexpected queue length ${b.queue}`);
  await settleLocalCapture(); // the gate is free again: let B's drain finish

  // C: real sign-up, settled before the hold.
  const cUser = await newUser("diag-c");
  await settleLocalCapture();
  const c = await observeGateQueue(cUser);
  t.diagnostic(`C real sign-up, settled: queue=${c.queue}, account outbox rows=${c.outbox}`);
  assert.equal(c.queue, 1, "C: settled sign-up leaves only the reclamation waiting");
});
