import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dataDir, origin } from "./wardrobeEnv";
import { waitForMail } from "./mailCapture";
import { getDatabase } from "../../src/server/database";
import { settleLocalCapture } from "../../src/server/mailOutbox";
import { writeGateQueueLength } from "../../src/server/writeGate";

/** Shared fixtures for the build-015 wardrobe tests (written, not executed). */
export { dataDir, origin };
export const DAY = 86_400_000;
export const photoBytes = readFileSync("tests/fixtures/public-shirt.jpg");
const password = "Test wardrobe passphrase 15!";
let counter = 0;

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

/** Number of outbox rows for one account (a count only, never ids or bodies). */
export const outboxRows = (userId: string) =>
  (
    getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE user_id=?")
      .get(userId) as { n: number }
  ).n;

/**
 * A repository-level account: the real Better Auth schema is created by
 * getReadyAuth(), then ONE `user` row is inserted directly. No sign-up, no
 * outbox row, no timer, no write-gate traffic, so nothing else can join a
 * queue the test builds behind a held gate. Real sign-up, verification and
 * captured mail stay covered by verifiedSession() and by accounts.test.ts,
 * mailCapture.test.ts, mailOutbox.test.ts and concurrency.test.ts.
 *
 * The `user` columns are read from PRAGMA table_info at run time. Known
 * columns get a value; any other NOT NULL column without a default makes the
 * fixture throw by name, so a wrong schema assumption fails here and cannot
 * silently pass. (Written, not executed.)
 */
export async function newRepositoryUser(label: string): Promise<string> {
  const { getReadyAuth } = await import("../../src/server/auth");
  await getReadyAuth();
  const db = getDatabase();
  const columns = db.prepare('PRAGMA table_info("user")').all() as ColumnInfo[];
  if (columns.length === 0)
    throw new Error("newRepositoryUser: the user table does not exist.");
  const id = "repo-" + randomUUID();
  const now = Date.now();
  const stamp = (column: ColumnInfo) =>
    /int|real|num/i.test(column.type) ? now : new Date(now).toISOString();
  const known: Record<string, (column: ColumnInfo) => unknown> = {
    id: () => id,
    name: () => label,
    email: () => `${label}-repo-${++counter}@example.test`,
    emailVerified: () => 0,
    createdAt: stamp,
    updatedAt: stamp,
  };
  for (const required of ["id", "email"])
    if (!columns.some((c) => c.name === required))
      throw new Error(`newRepositoryUser: user.${required} is missing.`);
  const names: string[] = [];
  const values: unknown[] = [];
  for (const column of columns) {
    const make = known[column.name];
    if (make) {
      names.push(column.name);
      values.push(make(column));
    } else if (column.notnull && column.dflt_value === null && !column.pk) {
      throw new Error(
        `newRepositoryUser: user.${column.name} is NOT NULL with no default and this fixture has no value for it.`,
      );
    }
  }
  db.prepare(
    `INSERT INTO "user"(${names.map((n) => `"${n}"`).join(",")}) VALUES(${names.map(() => "?").join(",")})`,
  ).run(...(values as (string | number)[]));
  // The capture seam must be idle too: an empty queue alone cannot see a drain
  // whose timer has not yet reached the gate (review F-L1). Nothing in this
  // function queues mail, so this normally returns at once; a capture left
  // over from an earlier test is waited out here, before the checks below.
  await settleLocalCapture({ timeoutMs: 1000 });
  // Hold-gate precondition made an assertion, not an assumption.
  if (outboxRows(id) !== 0)
    throw new Error("newRepositoryUser: the account has mail queued.");
  if (writeGateQueueLength() !== 0)
    throw new Error("newRepositoryUser: a writer is already queued on the gate.");
  return id;
}

/**
 * A signed-up (unverified) account through the REAL sign-up path. It queues
 * verification mail and schedules the local capture drain (a hidden writer), so
 * hold-the-gate repository tests must not use it; see newRepositoryUser. It is
 * kept for the A/B/C diagnostic and for tests that need real sign-up.
 */
export async function newUser(label: string): Promise<string> {
  const { getReadyAuth } = await import("../../src/server/auth");
  const auth = await getReadyAuth();
  const created = await auth.api.signUpEmail({
    body: {
      email: `${label}-${++counter}@example.test`,
      name: label,
      password,
    },
  });
  return created.user.id;
}

export type Session = { id: string; email: string; cookie: string };

/** A verified, signed-in account, set up as accounts.test.ts does it. */
export async function verifiedSession(label: string): Promise<Session> {
  const { getReadyAuth } = await import("../../src/server/auth");
  const auth = await getReadyAuth();
  const email = `${label}-${++counter}@example.test`;
  const created = await auth.api.signUpEmail({
    body: { email, password, name: label },
  });
  const mail = await waitForMail(dataDir, email, "Verify");
  const url = new URL(mail.text.split(": ").slice(1).join(": "));
  await auth.api.verifyEmail({
    query: { token: url.searchParams.get("token")! },
  });
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  // Quiescence BEFORE any test holds the gate: the capture drain needs the gate
  // to finish, so settling after a hold would only wait out the cap.
  await settleLocalCapture();
  return { id: created.user.id, email, cookie };
}

export function addPhoto(userId: string, ageMs: number): string {
  const id = "p-" + randomUUID();
  getDatabase()
    .prepare(
      "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
    )
    .run(id, userId, photoBytes, "hash-" + id, Date.now() - ageMs);
  return id;
}
export const photoExists = (id: string) =>
  Boolean(
    getDatabase().prepare("SELECT 1 FROM photo_assets WHERE id=?").get(id),
  );
export const wardrobeRows = (userId: string) =>
  (
    getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM wardrobe_spaces WHERE user_id=?")
      .get(userId) as { n: number }
  ).n;
export const storedRow = (userId: string) =>
  getDatabase()
    .prepare("SELECT revision,data_json FROM wardrobe_spaces WHERE user_id=?")
    .get(userId) as { revision: number; data_json: string } | undefined;
export function putRawRow(userId: string, revision: number, json: string) {
  getDatabase()
    .prepare(
      "INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
    )
    .run(userId, revision, json);
}

export const photoPath = (photo: string) => `/api/photos/${photo}`;

/** A garment whose `image` (and optionally `sourcePhoto`) are account photos. */
export const garment = (
  imagePhoto: string,
  name = "White tee",
  sourcePhoto?: string,
) => ({
  id: "g-" + name,
  name,
  category: "Tops",
  color: "white",
  brand: "",
  size: "",
  image: photoPath(imagePhoto),
  ...(sourcePhoto ? { sourcePhoto: photoPath(sourcePhoto) } : {}),
  reviewed: true,
});
/**
 * A garment whose `image` references no photo (empty string, which the
 * schema allows) and whose only photo reference, if any, is `sourcePhoto`.
 */
export const bareGarment = (name: string, sourcePhoto?: string) => ({
  ...garment("x", name, sourcePhoto),
  image: "",
});

/**
 * Oversize document (> 3,000,000 bytes serialized) that stays inside every
 * schema limit and references `photo`: 2000 wardrobe items and 150 looks of 10
 * items, each with its long optional fields filled.
 */
export function oversizeDocument(photo: string, revision = 0) {
  const item = (id: string) => ({
    id,
    name: "n".repeat(100),
    category: "c".repeat(60),
    color: "k".repeat(60),
    brand: "b".repeat(80),
    size: "s".repeat(40),
    image: photoPath(photo),
    pattern: "p".repeat(60),
    sleeve: "s".repeat(60),
    neckline: "n".repeat(60),
    closure: "c".repeat(60),
    length: "l".repeat(60),
    evidence: "e".repeat(250),
  });
  return {
    version: 1,
    name: "Oversize",
    wardrobe: Array.from({ length: 2000 }, (_, i) => item("w" + i)),
    looks: Array.from({ length: 150 }, (_, i) => ({
      id: "look" + i,
      name: "Look",
      occasion: "Casual",
      createdAt: "2026-01-01T00:00:00.000Z",
      items: Array.from({ length: 10 }, (_, j) => item(`l${i}-${j}`)),
    })),
    revision,
  };
}
export const look = (...items: ReturnType<typeof garment>[]) => ({
  id: "look-" + randomUUID().slice(0, 8),
  name: "Look",
  occasion: "Casual",
  createdAt: "2026-01-01T00:00:00.000Z",
  items,
});
/** A wardrobe document that references `photos` through wardrobe items. */
export const space = (revision: number, ...photos: string[]) => ({
  version: 1,
  name: "Test wardrobe",
  wardrobe: photos.map((p, i) => garment(p, "Tee " + i)),
  looks: [] as ReturnType<typeof look>[],
  revision,
});
