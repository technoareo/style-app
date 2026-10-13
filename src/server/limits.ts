/**
 * Runtime limits for image admission and the analysis queue. Every value has a
 * conservative default and an environment override; invalid or out-of-range
 * overrides are ignored (the default is used) so a typo can never disable a
 * bound. Read on each call so tests and operators can change them without a
 * module reload.
 *
 * These are starting values, not measured capacity. The target-server
 * benchmark must confirm or replace them (docs/DEPLOYMENT.md).
 */

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max
    ? Math.floor(value)
    : fallback;
}

/** Absolute lifetime of a temporary photo and any result, from upload. */
export const PHOTO_LIFETIME_MS = 60 * 60_000;

export function limits() {
  const maxUploadBytes = int(
    "STYLE_MAX_UPLOAD_BYTES",
    2_500_000,
    100_000,
    6_000_000,
  );
  return {
    // --- image admission (what the app's own client legitimately sends:
    // a canvas-normalized JPEG of at most 1600 px) ---
    maxUploadBytes,
    /** JSON body ceiling: base64 expansion of the image plus a small envelope. */
    maxBodyBytes: Math.ceil(maxUploadBytes / 3) * 4 + 65_536,
    maxUploadSide: int("STYLE_MAX_UPLOAD_SIDE", 2400, 256, 8000),
    maxUploadPixels: int("STYLE_MAX_UPLOAD_PIXELS", 6_000_000, 65_536, 32_000_000),
    bodyReadTimeoutMs: int("STYLE_BODY_READ_TIMEOUT_MS", 20_000, 1000, 120_000),
    // --- process-wide image work semaphore (body read + decode) ---
    imageConcurrency: int("STYLE_IMAGE_CONCURRENCY", 2, 1, 16),
    imageQueue: int("STYLE_IMAGE_QUEUE", 6, 0, 64),
    imageWaitMs: int("STYLE_IMAGE_WAIT_MS", 15_000, 100, 120_000),
    // --- analysis queue ---
    maxActivePerUser: 1,
    maxGlobalActive: int("STYLE_QUEUE_MAX_ACTIVE", 20, 1, 200),
    /** Chargeable analyses per account per UTC day (refunds restore these). */
    dailyChargeable: int("STYLE_DAILY_ANALYSES", 20, 1, 1000),
    /** Total accepted attempts per account per UTC day; refunds never reduce it. */
    dailyAttempts: int("STYLE_DAILY_ATTEMPTS", 40, 1, 5000),
    /**
     * Conservative per-photo work time used for admission and ETA. Measured
     * history can only raise it, never lower it, so an optimistic recent
     * average cannot overbook the queue.
     */
    analysisEstimateMs: int(
      "STYLE_ANALYSIS_ESTIMATE_MS",
      120_000,
      5_000,
      600_000,
    ),
    /** Time a user must still have, after the result is ready, to review it. */
    reviewBudgetMs: int("STYLE_REVIEW_BUDGET_MS", 10 * 60_000, 0, 30 * 60_000),
    inferenceTimeoutMs: int(
      "STYLE_INFERENCE_TIMEOUT_MS",
      240_000,
      10_000,
      900_000,
    ),
    /** How often the worker re-checks a running job for cancel/delete/expiry. */
    watchIntervalMs: int("STYLE_JOB_WATCH_MS", 1000, 20, 30_000),
  };
}

/**
 * Bounds for the durable account-mail outbox (src/server/mailOutbox.ts). Same
 * rules as limits(): invalid or out-of-range overrides fall back to the
 * default, and values are read on each call. Starting values, not measured
 * capacity or provider limits; the real SMTP relay's own limits must be
 * checked before launch.
 */
export function mailLimits() {
  const sendTimeoutMs = int("STYLE_MAIL_SEND_TIMEOUT_MS", 45_000, 500, 120_000);
  const heartbeatMs = int("STYLE_MAIL_HEARTBEAT_MS", 10_000, 50, 60_000);
  // A health window shorter than three beats would flap on one late timer.
  const requestedFresh = int("STYLE_MAIL_HEALTH_FRESH_MS", 60_000, 150, 600_000);
  return {
    /**
     * How often the worker's own timer reports in (build 009). The timer runs
     * on the event loop, so a stalled process stops reporting; it also stops
     * reporting when the worker loop makes no progress for longer than one
     * bounded step (see mailHealth.ts).
     */
    heartbeatMs,
    /** `--check` calls the worker healthy when its last report is younger than this. */
    healthFreshMs: Math.max(requestedFresh, heartbeatMs * 3),
    /** Outcome-record retries after a send (first try excluded) and the budget of each try. */
    recordRetries: int("STYLE_MAIL_RECORD_RETRIES", 8, 0, 20),
    recordAcquireMs: int("STYLE_MAIL_RECORD_ACQUIRE_MS", 5_000, 100, 30_000),
    /** The same two bounds once shutdown has started: short, then lease recovery takes over. */
    shutdownRecordRetries: int("STYLE_MAIL_SHUTDOWN_RECORD_RETRIES", 2, 0, 5),
    shutdownRecordAcquireMs: int(
      "STYLE_MAIL_SHUTDOWN_RECORD_ACQUIRE_MS",
      2_000,
      100,
      10_000,
    ),
    /** Hard exit after shutdown starts, whatever is still running (the lease recovers the rest). */
    shutdownExitMs: int("STYLE_MAIL_SHUTDOWN_EXIT_MS", 25_000, 500, 120_000),
    /**
     * A message is only worth sending while its link is still valid (both
     * Better Auth links live one hour). Messages not delivered inside this
     * window expire and their bodies are cleared, so a recipient who gets a
     * link always has at least ~15 minutes left to use it.
     */
    deliveryWindowMs: int(
      "STYLE_MAIL_WINDOW_MS",
      45 * 60_000,
      1_000,
      55 * 60_000,
    ),
    /** Total SMTP attempts per message (first try included). */
    maxAttempts: int("STYLE_MAIL_MAX_ATTEMPTS", 5, 1, 10),
    /** Backoff before attempt n+1 is min(cap, base * 4^(n-1)) plus <=10% jitter. */
    backoffBaseMs: int("STYLE_MAIL_BACKOFF_MS", 30_000, 10, 10 * 60_000),
    backoffCapMs: int("STYLE_MAIL_BACKOFF_CAP_MS", 20 * 60_000, 10, 30 * 60_000),
    /** Whole-send bound; nodemailer's own phase timeouts are tighter. */
    sendTimeoutMs,
    /** A claimed message is reclaimable once this lease lapses (worker died). */
    leaseMs: sendTimeoutMs + 60_000,
    /** Per recipient address and kind, trailing hour. */
    perRecipientKindPerHour: int("STYLE_MAIL_PER_RECIPIENT_HOUR", 4, 1, 100),
    /** Per recipient address, all kinds, trailing 24 hours. */
    perRecipientPerDay: int("STYLE_MAIL_PER_RECIPIENT_DAY", 12, 1, 500),
    /** Messages waiting or being sent, whole service. */
    maxPending: int("STYLE_MAIL_MAX_PENDING", 1000, 1, 100_000),
    /** Messages accepted into the outbox in the trailing hour, whole service. */
    maxPerHour: int("STYLE_MAIL_MAX_PER_HOUR", 600, 1, 100_000),
    /** Largest accepted text or html body, in bytes. */
    maxBodyBytes: 8_192,
    /** Delivered/expired/failed rows keep metadata only (no address, no body) this long. */
    terminalRetentionMs: 24 * 60 * 60_000,
  };
}
