import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rateLimitTables } from "../src/server/sensitiveTables";

/**
 * Build 022: read-only inspector for the CI encrypted-backup drill
 * (scripts/ci-backup-drill.ts). It runs INSIDE the real image (bind-mounted
 * next to the app code, never baked into it) or, in tests, directly.
 *
 *   facts   one JSON line of counts, booleans, hashes, modes and owners
 *   mail    one JSON line { link } for a captured mail (polls up to 30 s)
 *
 * It opens the database read-only and changes nothing (SQLite itself may create
 * its empty -wal/-shm bookkeeping files next to a WAL database; app.db's bytes
 * stay identical), and prints no account
 * data: no emails, no ids, no names, no photo or wardrobe content, no
 * passphrase. Photo and wardrobe content appear only as SHA-256 hashes so the
 * drill can compare a source volume with a restored one.
 *
 * Environment: STYLE_DATA_DIR (default /data), KEPT_ID, DELETED_ID,
 * HASH_DB=1 (hash app.db; only when nothing is writing), SECRET_FILE (report
 * the mode/owner of that file), MAIL_TO and MAIL_TEXT (mail mode).
 */

const dataDir = process.env.STYLE_DATA_DIR?.trim() || "/data";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const mode = (m: number) => (m & 0o777).toString(8).padStart(3, "0");

function fileInfo(file: string): { mode: string; uid: number } | null {
  try {
    const info = lstatSync(file);
    return { mode: mode(info.mode), uid: info.uid };
  } catch {
    return null;
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function databaseFacts(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (sql: string, ...args: string[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    const keptId = process.env.KEPT_ID ?? "";
    const deletedId = process.env.DELETED_ID ?? "";
    const photo = db
      .prepare("SELECT sha256, data FROM photo_assets WHERE user_id=? ORDER BY id")
      .all(keptId) as { sha256: string; data: Uint8Array }[];
    const wardrobe = db
      .prepare("SELECT revision, data_json FROM wardrobe_spaces WHERE user_id=?")
      .get(keptId) as { revision: number; data_json: string } | undefined;
    return {
      keptUserPresent: count("SELECT COUNT(*) AS n FROM user WHERE id=?", keptId) === 1,
      deletedUserPresent: count("SELECT COUNT(*) AS n FROM user WHERE id=?", deletedId) > 0,
      deletedUserRecorded:
        count("SELECT COUNT(*) AS n FROM account_deletions WHERE user_id=?", deletedId) === 1,
      deletedUserRows:
        count("SELECT COUNT(*) AS n FROM account WHERE userId=?", deletedId) +
        count("SELECT COUNT(*) AS n FROM photo_assets WHERE user_id=?", deletedId) +
        count("SELECT COUNT(*) AS n FROM wardrobe_spaces WHERE user_id=?", deletedId),
      photoCount: photo.length,
      photoHash: photo.length ? sha(photo.map((p) => p.sha256 + sha(Buffer.from(p.data))).join()) : null,
      wardrobeRevision: wardrobe ? wardrobe.revision : null,
      wardrobeHash: wardrobe ? sha(wardrobe.data_json) : null,
      sessions: count("SELECT COUNT(*) AS n FROM session"),
      verifications: count("SELECT COUNT(*) AS n FROM verification"),
      mailOutbox: count("SELECT COUNT(*) AS n FROM mail_outbox"),
      analysisJobs: count("SELECT COUNT(*) AS n FROM analysis_jobs"),
      rateLimitRows: rateLimitTables(db).reduce(
        (sum, t) => sum + count(`SELECT COUNT(*) AS n FROM "${t}"`),
        0,
      ),
      credentialPasswords: count(
        "SELECT COUNT(*) AS n FROM account WHERE providerId='credential' AND password IS NOT NULL",
      ),
      integrity: (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check,
    };
  } finally {
    db.close();
  }
}

function facts() {
  const dbFile = path.join(dataDir, "app.db");
  const exportsDir = path.join(dataDir, "exports");
  const dbExists = existsSync(dbFile);
  const secret = process.env.SECRET_FILE ? fileInfo(process.env.SECRET_FILE) : null;
  return {
    dbExists,
    dbOwnerUid: dbExists ? (fileInfo(dbFile)?.uid ?? null) : null,
    dbSha256: dbExists && process.env.HASH_DB === "1" ? sha(readFileSync(dbFile)) : null,
    exportsDirMode: fileInfo(exportsDir)?.mode ?? null,
    packages: names(exportsDir)
      .filter((n) => n.endsWith(".stylepkg"))
      .map((name) => ({ name, ...fileInfo(path.join(exportsDir, name)) })),
    partials: names(exportsDir).filter((n) => n.endsWith(".partial")).length,
    plainBackups: names(path.join(dataDir, "backups")).filter((n) => /^style-.*\.db$/.test(n))
      .length,
    stagingEntries: names(path.join(dataDir, "restore-staging")).length,
    pendingFiles: names(dataDir).filter((n) => n.endsWith(".pending")).length,
    mailCaptureFiles: names(path.join(dataDir, "mail-outbox")).length,
    secretFile: secret,
    db: dbExists ? databaseFacts(dbFile) : null,
  };
}

async function mailLink(): Promise<{ link: string }> {
  const to = process.env.MAIL_TO ?? "";
  const fragment = process.env.MAIL_TEXT ?? "";
  const dir = path.join(dataDir, "mail-outbox");
  const end = Date.now() + 30_000;
  for (;;) {
    let found: string | undefined;
    for (const file of names(dir).sort()) {
      try {
        const mail = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
          to?: string;
          text?: string;
        };
        if (mail.to === to && String(mail.text).includes(fragment))
          found = /https?:\/\/\S+/.exec(String(mail.text))?.[0] ?? found;
      } catch {
        // half-written; the next poll sees it whole
      }
    }
    if (found) return { link: found };
    if (Date.now() > end) throw new Error("no mail");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  const which = process.argv[2];
  if (which === "facts") console.log(JSON.stringify(facts()));
  else if (which === "mail") console.log(JSON.stringify(await mailLink()));
  else throw new Error("usage");
}

main().catch((error) => {
  console.error("inspect failed:", error instanceof Error ? error.message : "unexpected error");
  process.exit(1);
});
