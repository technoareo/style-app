import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDatabase } from "./database";
import { RequestError } from "./access";
import {
  analyzePhoto,
  ANSWER_CUT_MESSAGE,
  TOO_SLOW_MESSAGE,
  VisionError,
} from "./vision";
import { sleep } from "./sqliteRetry";
import { limits, PHOTO_LIFETIME_MS } from "./limits";
import {
  inTransaction,
  isWriteContention,
  runWriteTransaction,
  type WriteOptions,
} from "./writeTransaction";

/**
 * Durable photo-analysis queue on top of the `analysis_jobs` / `usage_daily`
 * tables defined in database.ts, plus the `worker_state` singleton owned
 * here. All mutations run inside a single BEGIN IMMEDIATE transaction with
 * no `await` inside it — node:sqlite's DatabaseSync API is synchronous, so
 * every statement in a transaction below executes to completion before the
 * next one starts.
 *
 * Time model (all measured from upload, `created_at`):
 *   - a photo and any result derived from it live at most PHOTO_LIFETIME_MS;
 *   - a job is admitted only if its conservative ready time plus the review
 *     budget still fits inside that lifetime (see checkAdmission);
 *   - the server returns that absolute deadline (`expiresAt`) with every job
 *     view, and clients poll against it rather than a private timeout.
 *
 * Quota model:
 *   - `usage_daily.count` is the chargeable allowance, `attempts` a separate
 *     abuse counter that is never refunded;
 *   - a job is refunded at most once (`analysis_jobs.refunded`) when it is
 *     cancelled while still queued, or fails for a server-side reason (model
 *     unavailable, worker lost, expired before completing). Completed jobs,
 *     unverifiable model output and cancelled *running* inference are not.
 */

export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export type FailureKind = "server" | "model" | "expired" | "cancelled";

export type JobView = {
  id: string;
  status: JobStatus;
  /** Epoch ms of upload. */
  createdAt?: number;
  /** Absolute server deadline for the photo and its result (epoch ms). */
  expiresAt?: number;
  /** Server clock at the time of the view, so clients can correct for skew. */
  serverNow?: number;
  /** 1 = being processed or next. Only for queued/running jobs. */
  position?: number;
  /** Conservative wait until inference starts. */
  estimatedStartMs?: number;
  /** Conservative wait until the result is ready. */
  estimatedReadyMs?: number;
  /** True once this job's daily allowance was returned. */
  refunded?: boolean;
  result?: unknown;
  error?: string;
};

const MAX_ATTEMPTS = 2;

const JOB_LEASE_MS = 10 * 60_000; // 4-minute inference timeout plus processing margin
// Absolute lifetime of a temporary photo (and any result derived from it),
// measured from created_at (upload) regardless of queued/running/completed.
const QUEUE_EXPIRE_MS = PHOTO_LIFETIME_MS;
// How long a terminal job row (failed/cancelled/expired, photo already
// cleared) remains readable before the row itself is deleted.
const RESULT_TTL_MS = 60 * 60_000;

const WORKER_LOCK_TTL_MS = 5 * 60_000; // a dead worker's global lock is reclaimable after 5 minutes
const WORKER_HEARTBEAT_FRESH_MS = 30_000; // how recent a heartbeat must be to call the worker "alive"

const QUEUE_EXPIRED_MESSAGE =
  "This temporary photo expired one hour after upload and was deleted. Upload it again to analyze it.";
const WORKER_LOST_MESSAGE =
  "This photo could not be analyzed after multiple attempts.";
const ANALYSIS_FAILED_MESSAGE = "This photo could not be analyzed. Try again.";
const ANALYSIS_UNAVAILABLE_MESSAGE =
  "Photo analysis was unavailable and this attempt was not counted. Try again shortly.";

let schemaReady = false;

function ensureSchema(db: DatabaseSync): void {
  if (schemaReady) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  lease_until INTEGER,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL
);
`);
  schemaReady = true;
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
const today = dayOf;

function secondsToUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now) / 1000));
}

/* ------------------------------------------------------------------ */
/* Quota refunds                                                      */
/* ------------------------------------------------------------------ */

/**
 * Returns one chargeable analysis to the job's owner, exactly once. The
 * `refunded` marker is flipped by a conditional UPDATE and the allowance only
 * moves when that UPDATE changed a row, so repeated calls (sweep, worker and
 * user racing) cannot refund twice. The abuse counter is untouched. Must be
 * called inside an open write transaction.
 */
function refundLocked(db: DatabaseSync, jobId: string): boolean {
  const job = db
    .prepare("SELECT user_id, created_at FROM analysis_jobs WHERE id=?")
    .get(jobId) as { user_id: string; created_at: number } | undefined;
  if (!job) return false;
  const flipped = db
    .prepare("UPDATE analysis_jobs SET refunded=1 WHERE id=? AND refunded=0")
    .run(jobId);
  if (Number(flipped.changes) !== 1) return false;
  db.prepare(
    "UPDATE usage_daily SET count = CASE WHEN count > 0 THEN count - 1 ELSE 0 END WHERE user_id=? AND day=?",
  ).run(job.user_id, dayOf(job.created_at));
  return true;
}

/* ------------------------------------------------------------------ */
/* Sweeps                                                             */
/* ------------------------------------------------------------------ */

type StaleRow = { id: string; status: JobStatus };

function expireJobLocked(db: DatabaseSync, row: StaleRow, now: number): void {
  db.prepare(
    "UPDATE analysis_jobs SET status='failed',error=?,input_image=NULL,result_json=NULL,lease_until=NULL,expires_at=?,failure_kind='expired',finished_at=? WHERE id=?",
  ).run(QUEUE_EXPIRED_MESSAGE, now + RESULT_TTL_MS, now, row.id);
  // Never completed: the user got nothing for this attempt.
  if (row.status === "queued" || row.status === "running")
    refundLocked(db, row.id);
}

/**
 * Requeues or fails running jobs whose lease has lapsed (a worker died
 * mid-job), fails any job still holding a photo or result more than one hour
 * after upload (queued, running or completed), and deletes terminal job rows
 * past their row TTL. Must only be called inside
 * an already-open BEGIN IMMEDIATE transaction on `db`.
 */
function sweepExpiredLocked(db: DatabaseSync, now: number): void {
  const stale = db
    .prepare(
      "SELECT id, status FROM analysis_jobs WHERE created_at + ? <= ? AND (input_image IS NOT NULL OR result_json IS NOT NULL)",
    )
    .all(QUEUE_EXPIRE_MS, now) as StaleRow[];
  for (const row of stale) expireJobLocked(db, row, now);
  const expiredRunning = db
    .prepare(
      "SELECT id, attempts FROM analysis_jobs WHERE status='running' AND lease_until IS NOT NULL AND lease_until < ?",
    )
    .all(now) as { id: string; attempts: number }[];
  for (const row of expiredRunning) {
    if (row.attempts < MAX_ATTEMPTS) {
      db.prepare(
        "UPDATE analysis_jobs SET status='queued', lease_until=NULL, started_at=NULL WHERE id=? AND status='running'",
      ).run(row.id);
    } else {
      db.prepare(
        "UPDATE analysis_jobs SET status='failed', error=?, input_image=NULL, lease_until=NULL, expires_at=?, failure_kind='server', finished_at=? WHERE id=? AND status='running'",
      ).run(WORKER_LOST_MESSAGE, now + RESULT_TTL_MS, now, row.id);
      refundLocked(db, row.id);
    }
  }
  const lateQueued = db
    .prepare(
      "SELECT id, status FROM analysis_jobs WHERE status='queued' AND expires_at IS NOT NULL AND expires_at < ?",
    )
    .all(now) as StaleRow[];
  for (const row of lateQueued) expireJobLocked(db, row, now);
  db.prepare(
    "DELETE FROM analysis_jobs WHERE status IN ('completed','failed','cancelled') AND expires_at IS NOT NULL AND expires_at < ?",
  ).run(now);
}

/* ------------------------------------------------------------------ */
/* Admission and estimates                                            */
/* ------------------------------------------------------------------ */

/**
 * Conservative per-photo work time. The configured estimate is a floor;
 * measured history (the last five completions, +25%) can only raise it, so a
 * run of quick photos cannot make the queue overbook itself. Never above the
 * inference timeout.
 */
function perJobEstimateMs(db: DatabaseSync): number {
  const { analysisEstimateMs, inferenceTimeoutMs } = limits();
  const rows = db
    .prepare(
      "SELECT duration_ms AS d FROM analysis_timings ORDER BY finished_at DESC LIMIT 5",
    )
    .all() as { d: number }[];
  const measured = rows.length
    ? Math.ceil(1.25 * (rows.reduce((sum, r) => sum + r.d, 0) / rows.length))
    : 0;
  return Math.max(analysisEstimateMs, Math.min(measured, inferenceTimeoutMs));
}

/** Slack per job for the worker's poll gap, claim, resize and result write. */
const WORKER_OVERHEAD_MS = 10_000;

/**
 * Hard per-photo bound used for ADMISSION (not for the displayed ETA): one
 * inference can legitimately run to the full inference timeout, so a queue is
 * only guaranteed to finish inside the photo lifetime if every job ahead is
 * assumed to take that long. The estimate may exceed it (operator floor), never
 * the other way round. A job re-run after a worker crash waits for a lease
 * (see jobLeaseMs) and is not covered by this guarantee; if it then misses the
 * hour it is expired and its allowance refunded.
 */
function worstCaseJobMs(db: DatabaseSync): number {
  return Math.max(
    perJobEstimateMs(db),
    limits().inferenceTimeoutMs + WORKER_OVERHEAD_MS,
  );
}

/** Lease must outlive the longest allowed inference plus a margin. */
function jobLeaseMs(): number {
  return Math.max(JOB_LEASE_MS, limits().inferenceTimeoutMs + 2 * 60_000);
}

/**
 * Read-only admission decision shared by the cheap pre-check (before the body
 * is read and the image decoded) and the atomic re-check inside the enqueue
 * transaction. Throws a RequestError carrying a retry hint when work cannot be
 * accepted.
 */
function checkAdmission(db: DatabaseSync, userId: string, now: number): void {
  const l = limits();
  const alive = now - QUEUE_EXPIRE_MS;
  const mine = db
    .prepare(
      "SELECT id FROM analysis_jobs WHERE user_id=? AND status IN ('queued','running') AND created_at > ? LIMIT 1",
    )
    .get(userId, alive) as { id: string } | undefined;
  if (mine)
    throw new RequestError(
      409,
      "You already have a photo analysis in progress.",
      { code: "active-job", jobId: mine.id },
    );
  const globalActive = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM analysis_jobs WHERE status IN ('queued','running') AND created_at > ?",
      )
      .get(alive) as { n: number }
  ).n;
  const perJob = perJobEstimateMs(db);
  if (globalActive >= l.maxGlobalActive)
    throw new RequestError(
      503,
      "Photo analysis is busy right now. Try again shortly.",
      {
        code: "busy",
        retryAfterSeconds: Math.max(15, Math.ceil(perJob / 1000)),
      },
    );
  // The new photo is processed after everything already active. Admission
  // assumes the WORST case per job (full inference timeout), so a photo that
  // is admitted still has its review time even if every job ahead runs to the
  // timeout. The running job is counted as a full job.
  const worst = worstCaseJobMs(db);
  const readyMs = (globalActive + 1) * worst;
  const overshoot = readyMs + l.reviewBudgetMs - QUEUE_EXPIRE_MS;
  if (overshoot > 0) {
    const drain = Math.ceil(overshoot / worst) * worst;
    throw new RequestError(
      503,
      "Photo analysis has a long wait right now, so your photo could not be reviewed before it expires. Try again later.",
      {
        code: "busy",
        retryAfterSeconds: Math.min(3600, Math.max(30, Math.ceil(drain / 1000))),
        estimatedReadyMs: readyMs,
      },
    );
  }
  const usage = db
    .prepare("SELECT count, attempts FROM usage_daily WHERE user_id=? AND day=?")
    .get(userId, today(now)) as
    | { count: number; attempts: number }
    | undefined;
  if ((usage?.count ?? 0) >= l.dailyChargeable)
    throw new RequestError(
      429,
      "You've reached today's photo analysis limit. Try again tomorrow.",
      { code: "daily-limit", retryAfterSeconds: secondsToUtcMidnight(now) },
    );
  if ((usage?.attempts ?? 0) >= l.dailyAttempts)
    throw new RequestError(
      429,
      "Too many photo analysis attempts today. Try again tomorrow.",
      { code: "attempt-limit", retryAfterSeconds: secondsToUtcMidnight(now) },
    );
}

/** Cheap, read-only pre-check: call before reading or decoding any image. */
export function precheckAnalysisAdmission(userId: string): void {
  const db = getDatabase();
  ensureSchema(db);
  checkAdmission(db, userId, Date.now());
}

export type Capacity = {
  accepting: boolean;
  estimatedWaitMs: number;
  perJobMs: number;
  retryAfterSeconds?: number;
  reason?: string;
};

/** What a new upload from this user would meet right now (read-only). */
export function analysisCapacity(userId: string): Capacity {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  const perJobMs = perJobEstimateMs(db);
  const active = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM analysis_jobs WHERE status IN ('queued','running') AND created_at > ?",
      )
      .get(now - QUEUE_EXPIRE_MS) as { n: number }
  ).n;
  try {
    checkAdmission(db, userId, now);
    return { accepting: true, estimatedWaitMs: active * perJobMs, perJobMs };
  } catch (e) {
    if (!(e instanceof RequestError)) throw e;
    return {
      accepting: false,
      estimatedWaitMs: active * perJobMs,
      perJobMs,
      retryAfterSeconds: e.extra?.retryAfterSeconds,
      reason: e.message,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                              */
/* ------------------------------------------------------------------ */

type JobRow = {
  rid: number;
  id: string;
  status: JobStatus;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  refunded: number;
};

const JOB_COLUMNS =
  "rowid AS rid, id, status, result_json, error, created_at, started_at, refunded";

function describe(
  db: DatabaseSync,
  row: JobRow,
  now: number,
  includeResult: boolean,
): JobView {
  const view: JobView = {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.created_at + QUEUE_EXPIRE_MS,
    serverNow: now,
  };
  if (row.refunded) view.refunded = true;
  if (row.status === "queued" || row.status === "running") {
    const perJob = perJobEstimateMs(db);
    const ahead = db
      .prepare(
        "SELECT status, started_at FROM analysis_jobs WHERE status IN ('queued','running') AND created_at > ? AND (created_at < ? OR (created_at = ? AND rowid < ?))",
      )
      .all(
        now - QUEUE_EXPIRE_MS,
        row.created_at,
        row.created_at,
        row.rid,
      ) as { status: JobStatus; started_at: number | null }[];
    const remaining = (startedAt: number | null) =>
      startedAt ? Math.max(0, perJob - (now - startedAt)) : perJob;
    if (row.status === "running") {
      view.position = 1;
      view.estimatedStartMs = 0;
      view.estimatedReadyMs = remaining(row.started_at);
    } else {
      const start = ahead.reduce(
        (sum, a) => sum + (a.status === "running" ? remaining(a.started_at) : perJob),
        0,
      );
      view.position = ahead.length + 1;
      view.estimatedStartMs = start;
      view.estimatedReadyMs = start + perJob;
    }
  }
  if (row.status === "completed" && includeResult)
    view.result = row.result_json ? JSON.parse(row.result_json) : null;
  if (row.status === "failed")
    view.error = row.error || ANALYSIS_FAILED_MESSAGE;
  return view;
}

/** Enqueues a new job for `userId` with the given canonical JPEG photo. */
export function enqueueAnalysisJob(userId: string, photo: Buffer): JobView {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  const day = today(now);
  return inTransaction(db, () => {
    sweepExpiredLocked(db, now);
    checkAdmission(db, userId, now);
    const id = randomUUID();
    db.prepare(
      "INSERT INTO analysis_jobs(id,user_id,status,input_image,created_at,expires_at,attempts) VALUES(?,?,'queued',?,?,?,0)",
    ).run(id, userId, photo, now, now + QUEUE_EXPIRE_MS);
    db.prepare(
      "INSERT INTO usage_daily(user_id,day,count,attempts) VALUES(?,?,1,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1, attempts=attempts+1",
    ).run(userId, day);
    const row = db
      .prepare(`SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE id=?`)
      .get(id) as JobRow;
    return describe(db, row, now, false);
  });
}

/** Reads a job owned by `userId`. Unknown id or a different owner both 404. */
export function getAnalysisJobForOwner(userId: string, id: string): JobView {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  inTransaction(db, () => {
    const stale = db
      .prepare(
        "SELECT id, status FROM analysis_jobs WHERE id=? AND user_id=? AND created_at + ? <= ? AND (input_image IS NOT NULL OR result_json IS NOT NULL)",
      )
      .get(id, userId, QUEUE_EXPIRE_MS, now) as StaleRow | undefined;
    if (stale) expireJobLocked(db, stale, now);
  });
  const row = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE id=? AND user_id=?`)
    .get(id, userId) as JobRow | undefined;
  if (!row) throw new RequestError(404, "Analysis job not found.");
  return describe(db, row, now, true);
}

/**
 * Owner-only discovery of active and recent jobs, newest first, without result
 * payloads (fetch one job for its result). Read-only: expired photos are
 * excluded by age rather than swept here. Cancelled/discarded jobs are not
 * listed.
 */
export function listJobsForOwner(userId: string): JobView[] {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM analysis_jobs WHERE user_id=? AND created_at > ? AND status IN ('queued','running','completed','failed') ORDER BY created_at DESC LIMIT 5`,
    )
    .all(userId, now - QUEUE_EXPIRE_MS) as JobRow[];
  return rows.map((row) => {
    const view = describe(db, row, now, false);
    if (row.status === "completed") view.result = undefined;
    return view;
  });
}

/**
 * Cancels a queued or running job, or discards a completed/failed one, owned
 * by `userId`, clearing its photo and any result immediately. Idempotent.
 * Unknown id or a different owner both 404.
 *
 * Refund policy: only a job cancelled while still queued gets its allowance
 * back. Cancelling running inference, or discarding a finished result, does
 * not; the work was done or deliberately abandoned. A running job's model call
 * is aborted by the worker's next watch tick (see runWorkerTick).
 */
export function cancelAnalysisJobForOwner(userId: string, id: string): JobView {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  return inTransaction(db, (): JobView => {
    const row = db
      .prepare("SELECT status FROM analysis_jobs WHERE id=? AND user_id=?")
      .get(id, userId) as { status: JobStatus } | undefined;
    if (!row) throw new RequestError(404, "Analysis job not found.");
    if (row.status !== "cancelled") {
      db.prepare(
        "UPDATE analysis_jobs SET status='cancelled', input_image=NULL, result_json=NULL, error=NULL, lease_until=NULL, expires_at=?, finished_at=COALESCE(finished_at, ?), failure_kind=COALESCE(failure_kind,'cancelled') WHERE id=? AND user_id=?",
      ).run(now + RESULT_TTL_MS, now, id, userId);
      if (row.status === "queued") refundLocked(db, id);
    }
    const refunded = (
      db.prepare("SELECT refunded FROM analysis_jobs WHERE id=?").get(id) as {
        refunded: number;
      }
    ).refunded;
    return {
      id,
      status: "cancelled",
      serverNow: now,
      ...(refunded ? { refunded: true } : {}),
    };
  });
}

/** Whether a worker has sent a heartbeat recently enough to call it alive. */
export function isWorkerHeartbeatRecent(): boolean {
  const db = getDatabase();
  ensureSchema(db);
  const row = db
    .prepare("SELECT heartbeat_at FROM worker_state WHERE id=1")
    .get() as { heartbeat_at: number | null } | undefined;
  return Boolean(
    row?.heartbeat_at &&
    Date.now() - row.heartbeat_at < WORKER_HEARTBEAT_FRESH_MS,
  );
}

/**
 * One-time startup maintenance: run the usual expiry sweep and drop
 * usage_daily rows older than 7 days. Intended to be called once by the
 * worker process at boot.
 */
export function cleanupOnStartup(): void {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  inTransaction(db, () => {
    sweepExpiredLocked(db, now);
    db.prepare("DELETE FROM usage_daily WHERE day < ?").run(
      today(now - 7 * 24 * 60 * 60_000),
    );
    db.prepare("DELETE FROM analysis_timings WHERE finished_at < ?").run(
      now - 6 * 60 * 60_000,
    );
  });
}

/**
 * Acquires the single global worker lock for `ownerId`. Returns false if
 * another owner currently holds an unexpired lock, so an accidentally
 * launched second worker process refuses to start rather than running GPU
 * inference concurrently with the first.
 */
export function acquireWorkerLock(ownerId: string): boolean {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  return inTransaction(db, () => {
    db.prepare(
      "INSERT OR IGNORE INTO worker_state(id, owner, lease_until, heartbeat_at, created_at) VALUES (1, NULL, NULL, NULL, ?)",
    ).run(now);
    const row = db
      .prepare("SELECT owner, lease_until FROM worker_state WHERE id=1")
      .get() as {
      owner: string | null;
      lease_until: number | null;
    };
    const free = !row.owner || !row.lease_until || row.lease_until < now;
    if (!free) return false;
    db.prepare(
      "UPDATE worker_state SET owner=?, lease_until=?, heartbeat_at=? WHERE id=1",
    ).run(ownerId, now + WORKER_LOCK_TTL_MS, now);
    return true;
  });
}

/**
 * Renews `ownerId`'s heartbeat and lock lease. Returns false if the lock is
 * no longer held by this owner (e.g. it expired and another worker claimed
 * it), signalling the caller to stop processing.
 */
export function renewWorkerLock(ownerId: string): boolean {
  const db = getDatabase();
  ensureSchema(db);
  const now = Date.now();
  return inTransaction(db, () => {
    const row = db
      .prepare("SELECT owner FROM worker_state WHERE id=1")
      .get() as { owner: string | null } | undefined;
    if (!row || row.owner !== ownerId) return false;
    db.prepare(
      "UPDATE worker_state SET lease_until=?, heartbeat_at=? WHERE id=1 AND owner=?",
    ).run(now + WORKER_LOCK_TTL_MS, now, ownerId);
    return true;
  });
}

/** Releases the global worker lock if still held by `ownerId`. */
export function releaseWorkerLock(ownerId: string): void {
  const db = getDatabase();
  ensureSchema(db);
  inTransaction(db, () => {
    db.prepare(
      "UPDATE worker_state SET owner=NULL, lease_until=NULL WHERE id=1 AND owner=?",
    ).run(ownerId);
  });
}

/*
 * Production (asynchronous) entry points for the worker process. They run the
 * synchronous functions above inside runWriteTransaction: bounded async lock
 * acquisition before the body, body never replayed, event loop never parked.
 * A WriteContentionError / WriteGateError means "not started, try again".
 */
export const cleanupOnStartupAsync = (options?: WriteOptions) =>
  runWriteTransaction(() => cleanupOnStartup(), options);
export const acquireWorkerLockAsync = (
  ownerId: string,
  options?: WriteOptions,
) => runWriteTransaction(() => acquireWorkerLock(ownerId), options);
export const renewWorkerLockAsync = (ownerId: string, options?: WriteOptions) =>
  runWriteTransaction(() => renewWorkerLock(ownerId), options);
export const releaseWorkerLockAsync = (
  ownerId: string,
  options?: WriteOptions,
) => runWriteTransaction(() => releaseWorkerLock(ownerId), options);

export type HeartbeatState = { lastRenewedAt: number };
export type HeartbeatResult = "ok" | "lost" | "degraded" | "critical";

/**
 * One worker heartbeat. Transient write contention is not fatal: the lock
 * lease is WORKER_LOCK_TTL_MS, so a failed renewal is "degraded" (keep
 * working, retry on the next beat) until the last successful renewal is more
 * than half a lease old, then "critical" (stop before the lease can lapse
 * under a still-running job). "lost" means another owner holds the lock.
 */
export async function heartbeatWorker(
  ownerId: string,
  state: HeartbeatState,
  options?: WriteOptions,
): Promise<HeartbeatResult> {
  try {
    if (!(await renewWorkerLockAsync(ownerId, options))) return "lost";
    state.lastRenewedAt = Date.now();
    return "ok";
  } catch (error) {
    if (!isWriteContention(error)) throw error;
    return Date.now() - state.lastRenewedAt > WORKER_LOCK_TTL_MS / 2
      ? "critical"
      : "degraded";
  }
}

/**
 * Writes the final outcome of a claimed job. Guarded by status='running'
 * AND the exact lease_until captured at claim time, so a job that was
 * cancelled, or whose lease was reassigned after expiring, silently drops
 * this (now stale) completion instead of resurrecting it.
 *
 * The photo's absolute deadline (created_at + QUEUE_EXPIRE_MS) is checked
 * here, inside the same transaction, using the current clock: if it has
 * passed, the outcome is replaced by an expiry failure and no result is
 * persisted, whether or not any GET or sweep ran first.
 *
 * Failures of kind 'server' and 'expired' return the user's allowance (once).
 */
function finishJobLocked(
  ownerId: string,
  id: string,
  leaseUntil: number,
  status: "completed" | "failed",
  resultJson: string | null,
  error: string | null,
  kind: FailureKind | null,
): void {
  const db = getDatabase();
  const now = Date.now();
  inTransaction(db, () => {
    const job = db
      .prepare(
        "SELECT created_at, started_at FROM analysis_jobs WHERE id=? AND status='running' AND lease_until=? AND EXISTS(SELECT 1 FROM worker_state WHERE id=1 AND owner=? AND lease_until>=?)",
      )
      .get(id, leaseUntil, ownerId, now) as
      | { created_at: number; started_at: number | null }
      | undefined;
    if (!job) return;
    const expired = job.created_at + QUEUE_EXPIRE_MS <= now;
    const finalStatus = expired ? "failed" : status;
    const finalKind: FailureKind | null =
      finalStatus === "completed" ? null : expired ? "expired" : kind;
    const changed = db
      .prepare(
        "UPDATE analysis_jobs SET status=?, result_json=?, error=?, input_image=NULL, lease_until=NULL, expires_at=?, finished_at=?, failure_kind=? WHERE id=? AND status='running' AND lease_until=?",
      )
      .run(
        finalStatus,
        expired ? null : resultJson,
        expired
          ? QUEUE_EXPIRED_MESSAGE
          : finalStatus === "failed" && finalKind === "server"
            ? error || ANALYSIS_UNAVAILABLE_MESSAGE
            : error,
        // Within the deadline the result is readable until the absolute
        // deadline; after it, the failure row stays readable for RESULT_TTL_MS.
        expired
          ? now + RESULT_TTL_MS
          : Math.min(job.created_at + QUEUE_EXPIRE_MS, now + RESULT_TTL_MS),
        now,
        finalKind,
        id,
        leaseUntil,
      );
    if (Number(changed.changes) !== 1) return;
    if (finalStatus === "completed" && job.started_at)
      db.prepare(
        "INSERT INTO analysis_timings(finished_at, duration_ms) VALUES(?, ?)",
      ).run(now, Math.max(0, now - job.started_at));
    if (finalStatus === "failed" && (finalKind === "server" || finalKind === "expired"))
      refundLocked(db, id);
  });
}

/**
 * Returns a job this worker was running to the queue (graceful shutdown).
 * Guarded by the exact lease; the attempt it consumed is given back.
 */
function requeueRunningLocked(id: string, leaseUntil: number): void {
  const db = getDatabase();
  inTransaction(db, () => {
    db.prepare(
      "UPDATE analysis_jobs SET status='queued', lease_until=NULL, started_at=NULL, attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END WHERE id=? AND status='running' AND lease_until=?",
    ).run(id, leaseUntil);
  });
}

export type TickOptions = {
  /** Budget for each lock acquisition (claim, finish attempt). Default 10 s. */
  writeTimeoutMs?: number;
  /**
   * How long to keep retrying to record a finished job when the database is
   * contended. Default: until 30 s before the job's lease would lapse.
   */
  finishRetryMs?: number;
  /** How often a running job is re-checked for cancel/delete/expiry. */
  watchIntervalMs?: number;
};

/**
 * Records a job outcome, retrying only failed lock acquisition (the body
 * never ran, so nothing is replayed and, crucially, inference is not
 * repeated: the finished result is held in memory meanwhile). Gives up when
 * the retry budget or the lease margin is exhausted and returns false; the
 * job then stays `running`, keeps its photo, and is requeued by the normal
 * lease sweep (at most MAX_ATTEMPTS inference runs in total).
 */
async function finishJob(
  ownerId: string,
  id: string,
  leaseUntil: number,
  status: "completed" | "failed",
  resultJson: string | null,
  error: string | null,
  kind: FailureKind | null,
  options: TickOptions,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Math.min(
    leaseUntil - 30_000,
    Date.now() + (options.finishRetryMs ?? jobLeaseMs()),
  );
  for (;;) {
    try {
      await runWriteTransaction(
        () =>
          finishJobLocked(
            ownerId,
            id,
            leaseUntil,
            status,
            resultJson,
            error,
            kind,
          ),
        { acquireTimeoutMs: options.writeTimeoutMs },
      );
      return true;
    } catch (e) {
      if (!isWriteContention(e)) throw e;
      if (Date.now() >= deadline || signal?.aborted) {
        console.error(
          "Could not record an analysis result under database contention; the job will be requeued after its lease.",
        );
        return false;
      }
      await sleep(250);
    }
  }
}

type AbortReason = "cancelled" | "deleted" | "lease" | "expired";

/**
 * Processes at most one queued job: atomically claims the earliest eligible
 * job, runs inference sequentially (awaited in place, never detached), and
 * writes the outcome. Returns false when there was nothing queued.
 *
 * While inference is in flight a read-only watcher re-checks the claimed job
 * every `watchIntervalMs` (default 1 s): if the row is gone (account deleted),
 * no longer `running` (cancelled), carries a different lease, is owned by
 * another worker, or has passed its absolute lifetime, the model request is
 * aborted at once so the sequential worker is free for the next job. An abort
 * for cancel/delete/lease records nothing (the row already says what
 * happened); an abort for expiry records the expiry failure; an abort because
 * this process is shutting down returns the job to the queue.
 *
 * The caller is responsible for heartbeating `ownerId`'s lock while this is
 * in flight; this function does not itself renew the lock except via the
 * caller-supplied heartbeat during the (potentially long) inference call.
 */
export async function runWorkerTick(
  ownerId: string,
  onClaimed: () => void,
  onSettled: () => void,
  signal?: AbortSignal,
  options: TickOptions = {},
): Promise<boolean> {
  const db = getDatabase();
  ensureSchema(db);
  // The claim runs through the production write path: bounded async lock
  // acquisition, then a synchronous body. If the database stays contended
  // past the budget this rejects before claiming anything, so no job state
  // changes and the worker simply tries again on its next tick.
  const claim = await runWriteTransaction(
    (): { id: string; lease: number } | null => {
      const now = Date.now();
      const lock = db
        .prepare("SELECT owner,lease_until FROM worker_state WHERE id=1")
        .get() as { owner: string; lease_until: number } | undefined;
      if (!lock || lock.owner !== ownerId || lock.lease_until <= now)
        return null;
      db.prepare(
        "UPDATE worker_state SET lease_until=?,heartbeat_at=? WHERE id=1 AND owner=?",
      ).run(now + WORKER_LOCK_TTL_MS, now, ownerId);
      sweepExpiredLocked(db, now);
      const row = db
        .prepare(
          "SELECT id FROM analysis_jobs WHERE status='queued' AND attempts < ? ORDER BY created_at ASC LIMIT 1",
        )
        .get(MAX_ATTEMPTS) as { id: string } | undefined;
      if (!row) return null;
      const lease = now + jobLeaseMs();
      db.prepare(
        "UPDATE analysis_jobs SET status='running', attempts=attempts+1, lease_until=?, started_at=? WHERE id=? AND status='queued'",
      ).run(lease, now, row.id);
      return { id: row.id, lease };
    },
    { acquireTimeoutMs: options.writeTimeoutMs },
  );
  if (!claim) return false;
  const claimedId = claim.id;
  const claimedLease = claim.lease;

  const photoRow = db
    .prepare("SELECT input_image, created_at FROM analysis_jobs WHERE id=?")
    .get(claimedId) as
    { input_image: Uint8Array | null; created_at: number } | undefined;

  onClaimed();

  // Read-only watcher: aborts the model call when the job is cancelled,
  // deleted with its account, reassigned, or past its absolute lifetime.
  const jobAbort = new AbortController();
  let abortReason: AbortReason | null = null;
  const watcher = setInterval(() => {
    try {
      const row = db
        .prepare(
          "SELECT status, lease_until, created_at FROM analysis_jobs WHERE id=?",
        )
        .get(claimedId) as
        | { status: JobStatus; lease_until: number | null; created_at: number }
        | undefined;
      const owner = db
        .prepare("SELECT owner FROM worker_state WHERE id=1")
        .get() as { owner: string | null } | undefined;
      const reason: AbortReason | null = !row
        ? "deleted"
        : row.status !== "running"
          ? "cancelled"
          : row.lease_until !== claimedLease || owner?.owner !== ownerId
            ? "lease"
            : row.created_at + QUEUE_EXPIRE_MS <= Date.now()
              ? "expired"
              : null;
      if (reason && !abortReason) {
        abortReason = reason;
        jobAbort.abort();
      }
    } catch {
      // A transient read failure is retried on the next interval.
    }
  }, options.watchIntervalMs ?? limits().watchIntervalMs);

  let outcomeArgs:
    | ["completed" | "failed", string | null, string | null, FailureKind | null]
    | null = null;
  try {
    try {
      if (!photoRow?.input_image) throw new Error("missing-input");
      const photo = Buffer.from(photoRow.input_image);
      // Bound inference by the photo's remaining lifetime so it cannot run
      // past the absolute deadline; finishJob re-checks the clock regardless.
      const remainingMs = photoRow.created_at + QUEUE_EXPIRE_MS - Date.now();
      if (remainingMs <= 0) throw new Error("photo-expired");
      const signals = [jobAbort.signal, AbortSignal.timeout(remainingMs)];
      if (signal) signals.push(signal);
      const outcome = await analyzePhoto(photo, AbortSignal.any(signals));
      // Flattened to {items, warning, image} — the shape the client parses
      // with analysisSchema and reads `.image` from directly.
      const resultJson = JSON.stringify({
        ...outcome.analysis,
        image: outcome.image,
      });
      outcomeArgs = ["completed", resultJson, null, null];
    } catch (e) {
      const why = abortReason as AbortReason | null;
      if (why === "cancelled" || why === "deleted" || why === "lease") {
        // The row already records the outcome; nothing to write.
        outcomeArgs = null;
      } else if (signal?.aborted && why === null) {
        // Graceful shutdown: give the job back instead of failing it.
        try {
          await runWriteTransaction(
            () => requeueRunningLocked(claimedId, claimedLease),
            { acquireTimeoutMs: options.writeTimeoutMs ?? 2000 },
          );
        } catch {
          // The lease sweep will requeue it.
        }
        outcomeArgs = null;
      } else if (why === "expired") {
        outcomeArgs = ["failed", null, QUEUE_EXPIRED_MESSAGE, "expired"];
      } else if (e instanceof VisionError && e.kind === "unverified") {
        // A cut-off answer keeps its own cause-neutral message; any other
        // verification failure gets the generic retry text.
        outcomeArgs = [
          "failed",
          null,
          e.message === ANSWER_CUT_MESSAGE
            ? e.message
            : ANALYSIS_FAILED_MESSAGE,
          "model",
        ];
      } else if (e instanceof VisionError && e.kind === "timeout") {
        // Past the inference deadline: still a server-side failure (the
        // attempt is not counted), but the user is told what to change.
        outcomeArgs = ["failed", null, TOO_SLOW_MESSAGE, "server"];
      } else {
        // Model unreachable, timed out, input missing: a server-side failure.
        outcomeArgs = [
          "failed",
          null,
          ANALYSIS_UNAVAILABLE_MESSAGE,
          "server",
        ];
      }
    }
  } finally {
    clearInterval(watcher);
  }
  try {
    if (outcomeArgs)
      // Contention is retried only until the result is recorded; inference is
      // never repeated for it. See finishJob.
      await finishJob(
        ownerId,
        claimedId,
        claimedLease,
        ...outcomeArgs,
        options,
        signal,
      );
  } finally {
    onSettled();
  }
  return true;
}
