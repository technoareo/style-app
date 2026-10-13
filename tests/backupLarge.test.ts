import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackup, FINAL_BACKUP } from "../src/server/backupDatabase";
import { forkHelper, sleep } from "./helpers/processes";

/**
 * Build 010, H2: can a backup of a LARGE live database finish while another
 * process keeps committing writes to it?
 *
 * SQLite restarts an online backup from the beginning whenever another
 * connection writes to the source between two copy steps. The application
 * writes every few seconds (mail and AI worker heartbeats, sessions, jobs), so
 * a backup that copies in many small steps could, on a big database, never
 * finish. This test builds a database of at least 300 MB and runs the real
 * createBackup() with an explicit bound on completion against a SEPARATE
 * writer process, in three runs:
 *
 *   0. calibration, no writer: measures the raw-copy interval on this machine;
 *   1. the specified writer period (5 s);
 *   2. a SHORTER documented period derived from the calibration
 *      (a quarter of the raw-copy time, between 20 ms and 5 s), chosen so that
 *      several commits must land inside the copy even on a fast machine.
 *
 * What counts as "overlap" (build 010 corrections). The first version counted
 * IPC messages sampled after the whole backup, which proved nothing. The second
 * stored the clock BEFORE each statement, so a writer blocked until after the
 * copy could still "overlap". Now the writer commits each write as one
 * autocommit statement and records [start, end]: its clock before the
 * statement and after `run()` returned. After the backup the parent asks the
 * writer to stop; the writer closes its database and sends ONE message with
 * every interval (an acknowledged barrier; message timing decides nothing), and
 * the parent cross-checks the count and start times against the durable
 * `writes` rows. A write overlaps only if its WHOLE interval lies strictly
 * inside the copy: from the `copy-started` stage (immediately before
 * node:sqlite backup(), after directory, lock and sweep work) to the
 * `raw-copied` stage. Sanitising, VACUUM and verification run on the copy and
 * are not part of it. The predicate is tested on its own (always runs).
 *
 *  - run 2 must show at least 2 overlapping commits, or the test FAILS as
 *    inconclusive (use STYLE_LARGE_BACKUP_MB larger);
 *  - run 1 must show at least 1 if its raw copy lasted longer than the period;
 *    otherwise it is reported as `inconclusiveAtSpecifiedPeriod` in the output,
 *    because a fast machine can copy 300 MB between two writes 5 s apart.
 *
 * Resource-intensive (about 1.5 GB of disk and several minutes), so opt-in:
 *
 *   STYLE_LARGE_BACKUP_TEST=1 npx tsx --test tests/backupLarge.test.ts
 *
 * Optional: STYLE_LARGE_BACKUP_MB (default 300, never below 300),
 * STYLE_LARGE_BACKUP_BOUND_MS (per backup, default 300000).
 * Passing on a fast local SSD says nothing about a slow or network volume.
 */

const enabled = process.env.STYLE_LARGE_BACKUP_TEST === "1";
const SIZE_MB = Math.max(300, Number(process.env.STYLE_LARGE_BACKUP_MB) || 300);
const BOUND_MS = Number(process.env.STYLE_LARGE_BACKUP_BOUND_MS) || 300_000;

/**
 * A write counts as overlapping the copy only if its ENTIRE interval, from the
 * child's clock before the statement to its clock after the statement
 * returned, lies strictly inside the copy (`copy-started` .. `raw-copied`).
 * A write that began inside but finished after the copy ended (for example
 * one blocked until the copy was over) does not count, and neither does one
 * that began before the copy started.
 */
function writeInsideCopy(
  start: number,
  end: number,
  copyStartedAt: number,
  copyEndedAt: number,
): boolean {
  return end >= start && start > copyStartedAt && end < copyEndedAt;
}

test("the overlap predicate counts only writes whose whole interval is strictly inside the copy", () => {
  const [from, to] = [1_000, 2_000];
  assert.equal(writeInsideCopy(1_200, 1_250, from, to), true, "fully inside");
  assert.equal(writeInsideCopy(1_001, 1_999, from, to), true, "fully inside, close to both edges");
  assert.equal(writeInsideCopy(1_900, 2_600, from, to), false, "starts inside, completes after the copy ended (a blocked writer)");
  assert.equal(writeInsideCopy(1_999, 2_000, from, to), false, "completes exactly at the end: not strictly inside");
  assert.equal(writeInsideCopy(800, 1_300, from, to), false, "starts before the copy, completes inside");
  assert.equal(writeInsideCopy(1_000, 1_100, from, to), false, "starts exactly at the start: not strictly inside");
  assert.equal(writeInsideCopy(500, 600, from, to), false, "entirely before");
  assert.equal(writeInsideCopy(2_100, 2_200, from, to), false, "entirely after");
  assert.equal(writeInsideCopy(500, 3_000, from, to), false, "spans the whole copy");
  // The writer's own clock cannot run backwards inside one write.
  assert.equal(writeInsideCopy(1_500, 1_400, from, to), false, "end before start is rejected");
});

test(
  "a backup of a database of 300 MB or more completes within the bound while another process commits writes inside the copy, and passes an integrity check",
  {
    skip: enabled ? false : "resource-intensive: set STYLE_LARGE_BACKUP_TEST=1 to run",
    timeout: 3 * BOUND_MS + 900_000,
  },
  async () => {
    const dir = path.join(process.cwd(), ".data", "tests", `large-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "app.db");
    const source = new DatabaseSync(file, { timeout: 30_000 });
    let writer: ReturnType<typeof forkHelper> | null = null;
    let writesBefore = 0;

    type Snapshot = { intervals: [number, number][]; failed: number } | null;

    /**
     * Acknowledged stop barrier: asks the writer to stop and waits for its ONE
     * final message (the complete list of [start, end] intervals), then for its
     * exit. A writer that does not answer is killed and the run has no
     * snapshot (the caller fails on that).
     */
    async function stopWriter(): Promise<Snapshot> {
      if (!writer) return null;
      const w = writer;
      writer = null;
      let snapshot: Snapshot = null;
      if (w.proc.exitCode === null) {
        w.proc.send("stop");
        try {
          const message = await w.next((m) => m.stopped === true, 30_000);
          snapshot = {
            intervals: message.intervals as [number, number][],
            failed: Number(message.failed),
          };
        } catch {
          snapshot = null;
        }
      }
      const done = await Promise.race([w.exited, sleep(30_000).then(() => "stuck" as const)]);
      if (done === "stuck") {
        w.proc.kill("SIGKILL");
        await w.exited;
      }
      return snapshot;
    }

    async function measure(periodMs: number | null) {
      if (periodMs !== null) {
        writer = forkHelper("tests/helpers/slowWriterChild.ts", {
          STYLE_DATA_DIR: dir,
          WRITER_EVERY_MS: String(periodMs),
        });
        await writer.next((m) => m.ready === true);
      }
      const startedAt = Date.now();
      let copyStartedAt = 0;
      let rawCopiedAt = 0;
      let timer: NodeJS.Timeout | undefined;
      let result: Awaited<ReturnType<typeof createBackup>>;
      let snapshot: Snapshot = null;
      try {
        result = await Promise.race([
          createBackup(source, {
            dataDir: dir,
            lockWaitMs: 0,
            onStage: (stage) => {
              if (stage === "copy-started") copyStartedAt = Date.now();
              if (stage === "raw-copied") rawCopiedAt = Date.now();
            },
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`the backup did not complete within ${BOUND_MS} ms`)),
              BOUND_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        // Stop barrier: the child has acknowledged, closed its database and
        // handed over every interval it recorded.
        snapshot = await stopWriter();
      }
      const totalMs = Date.now() - startedAt;
      assert.ok(totalMs < BOUND_MS, `completed within the bound (${totalMs} ms)`);
      assert.ok(copyStartedAt > 0 && rawCopiedAt >= copyStartedAt, "copy-started and raw-copied were observed in order");
      const rawCopyMs = rawCopiedAt - copyStartedAt;

      // Child-recorded intervals only (never message delivery times), with a
      // durable cross-check: the table must hold exactly the writes the child
      // says it completed, with the same start times.
      let overlapping = 0;
      let failedWrites = 0;
      let writesInRun = 0;
      if (periodMs !== null) {
        assert.ok(snapshot, "the writer acknowledged the stop and reported its intervals");
        const rows = (
          source.prepare("SELECT at FROM writes ORDER BY id").all() as { at: number }[]
        ).map((r) => r.at);
        const earlier = writesBefore;
        assert.equal(
          rows.length - earlier,
          snapshot.intervals.length,
          "durable row count equals the writes the child reports",
        );
        assert.deepEqual(
          rows.slice(earlier),
          snapshot.intervals.map((i) => i[0]),
          "durable start times equal the reported ones",
        );
        writesBefore = rows.length;
        writesInRun = snapshot.intervals.length;
        failedWrites = snapshot.failed;
        overlapping = snapshot.intervals.filter(([start, end]) =>
          writeInsideCopy(start, end, copyStartedAt, rawCopiedAt),
        ).length;
      }

      const backups = path.join(dir, "backups");
      assert.ok(!readdirSync(backups).some((n) => n.includes(".partial")));
      const copy = new DatabaseSync(path.join(backups, result.file), { readOnly: true });
      try {
        assert.equal(
          (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
            .integrity_check,
          "ok",
        );
        assert.equal(
          (copy.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n,
          SIZE_MB,
          "every row was copied",
        );
        for (const table of ["analysis_jobs", "mail_outbox", "verification", "session"])
          assert.equal(
            (copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
            0,
          );
      } finally {
        copy.close();
      }
      // Free the disk before the next run.
      for (const n of readdirSync(backups).filter((x) => FINAL_BACKUP.test(x)))
        unlinkSync(path.join(backups, n));
      return { periodMs, rawCopyMs, totalMs, overlapping, failedWrites, writesInRun };
    }

    try {
      source.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE analysis_jobs(id TEXT, input_image BLOB);
        CREATE TABLE mail_outbox(id TEXT, body TEXT);
        CREATE TABLE verification(id TEXT, value TEXT);
        CREATE TABLE session(id TEXT, token TEXT);
        CREATE TABLE blobs(id INTEGER PRIMARY KEY, data BLOB NOT NULL);
        CREATE TABLE writes(id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
      `);
      source.exec("BEGIN");
      const insert = source.prepare("INSERT INTO blobs(data) VALUES (randomblob(1048576))");
      for (let i = 0; i < SIZE_MB; i++) insert.run();
      source.exec("COMMIT");
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const sourceBytes = statSync(file).size;
      assert.ok(
        sourceBytes >= 300 * 1024 * 1024,
        `the source database is at least 300 MB (${sourceBytes})`,
      );

      const calibration = await measure(null);
      const specified = await measure(5000);
      const shortPeriod = Math.min(5000, Math.max(20, Math.floor(calibration.rawCopyMs / 4)));
      const shorter = await measure(shortPeriod);

      const inconclusiveAtSpecifiedPeriod =
        specified.rawCopyMs < 5000 && specified.overlapping === 0;
      console.log(
        JSON.stringify({
          largeBackup: {
            sourceBytes,
            boundMs: BOUND_MS,
            calibration,
            specifiedPeriod: specified,
            shorterPeriod: shorter,
            inconclusiveAtSpecifiedPeriod,
          },
        }),
      );

      if (specified.rawCopyMs >= 5000)
        assert.ok(
          specified.overlapping >= 1,
          `a writer committing every 5 s landed no write inside a ${specified.rawCopyMs} ms copy`,
        );
      assert.equal(shorter.failedWrites, 0, "no writer write failed");
      assert.ok(
        shorter.overlapping >= 2,
        `INCONCLUSIVE: only ${shorter.overlapping} committed write(s) landed inside a ${shorter.rawCopyMs} ms raw copy at a ${shortPeriod} ms period; use a larger STYLE_LARGE_BACKUP_MB`,
      );
    } finally {
      await stopWriter();
      try {
        source.close();
      } catch {
        // Already closed.
      }
      // This test's own scratch directory (created above under .data/tests).
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
