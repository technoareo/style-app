import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import { getAuthDatabase, getDatabase } from "./database";
import { mailLimits } from "./limits";
import {
  assertAccountRecipient,
  classifyMailError,
  deliverMessage,
  passwordResetMessage,
  usesLocalCapture,
  verificationMessage,
  type Message,
} from "./mail";
import { sleep } from "./sqliteRetry";
import {
  DEFAULT_WRITE_ACQUIRE_MS,
  isWriteContention,
  runWriteTransaction,
} from "./writeTransaction";

/**
 * Durable account-mail outbox (build 008).
 *
 * Requests never talk to SMTP. Better Auth's verification and password-reset
 * callbacks only INSERT a row here (a fast local write); the supervised mail
 * worker (scripts/mail-worker.ts) claims rows, sends them, and records the
 * outcome. Delivery is AT-LEAST-ONCE: a worker that dies between the SMTP
 * acknowledgement and recording it will send the message again after its lease
 * lapses. It is never exactly-once, and nothing here pretends otherwise.
 *
 * Atomicity, stated exactly:
 *  - Sign-up: Better Auth runs the whole handler inside one transaction on the
 *    auth connection. The verification callback runs inside that transaction
 *    (the supported background handler is NOT configured, so Better Auth awaits
 *    the callback), and the outbox row is inserted on that same connection.
 *    A mail row that IS written is therefore part of that transaction: it
 *    commits with the user and credential rows or disappears with them (shown
 *    for the mail insert by tests/mailOutbox.test.ts; that the real handler
 *    puts createUser and linkAccount in the same transaction is from reading
 *    Better Auth's sign-up.mjs, not from an end-to-end failure test).
 *    This does NOT mean every sign-up produces a mail: a failure to insert is
 *    caught and logged by Better Auth and does not roll the sign-up back, and
 *    a bound (per-address, daily, queue-full, hourly, invalid) drops the
 *    message silently by design. Either way the user has an unverified
 *    account and can request a new link by signing in once the bound allows.
 *  - Password reset and verification resend: Better Auth creates the reset
 *    token (an ordinary committed write) and only then calls the callback,
 *    which enqueues in its own transaction. A crash between the two leaves a
 *    token nobody was mailed, which is harmless; a mail row without its token
 *    cannot occur.
 *  - Verification links are stateless signed tokens; nothing about them is
 *    stored except inside the queued message body, which is cleared on
 *    delivery, expiry, failure, supersession and account deletion.
 *
 * Every statement that changes rows runs inside a caller-owned write
 * transaction (runWriteTransaction for the main connection, Better Auth's own
 * transaction for the sign-up path). No function here begins, commits or
 * awaits SMTP inside a transaction, and none takes the write gate while the
 * caller already holds it.
 */

export type MailKind = "verify-email" | "reset-password";
export type MailInput = Message & { userId: string; kind: MailKind };
export type EnqueueResult =
  | { status: "queued"; id: string }
  | { status: "dropped"; reason: "recipient-limit" | "queue-full" | "invalid" };

const CLEAR_BODIES =
  "to_address=NULL, subject=NULL, text_body=NULL, html_body=NULL, lease_until=NULL";

export const recipientKey = (address: string) =>
  createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/**
 * Inserts one message. Synchronous and transaction-neutral: the caller must
 * already hold an open write transaction on `db`, and this function neither
 * begins nor commits one (a rollback by the caller removes the row).
 * Over-limit requests are dropped silently (the caller cannot tell, so the
 * public responses stay generic) and reported only as a reason code.
 */
export function insertMailLocked(
  db: DatabaseSync,
  input: MailInput,
  now: number = Date.now(),
): EnqueueResult {
  if (!db.isTransaction)
    throw new Error("Mail enqueue requires an open transaction.");
  const l = mailLimits();
  try {
    assertAccountRecipient(input.to);
  } catch {
    return { status: "dropped", reason: "invalid" };
  }
  if (
    Buffer.byteLength(input.text) > l.maxBodyBytes ||
    Buffer.byteLength(input.html) > l.maxBodyBytes ||
    input.subject.length > 200
  )
    return { status: "dropped", reason: "invalid" };
  const key = recipientKey(input.to);
  if (
    count(
      db,
      "SELECT COUNT(*) AS n FROM mail_outbox WHERE recipient_key=? AND kind=? AND created_at>?",
      key,
      input.kind,
      now - 3_600_000,
    ) >= l.perRecipientKindPerHour ||
    count(
      db,
      "SELECT COUNT(*) AS n FROM mail_outbox WHERE recipient_key=? AND created_at>?",
      key,
      now - 86_400_000,
    ) >= l.perRecipientPerDay
  )
    return { status: "dropped", reason: "recipient-limit" };
  if (
    count(
      db,
      "SELECT COUNT(*) AS n FROM mail_outbox WHERE status IN ('queued','sending')",
    ) >= l.maxPending ||
    count(
      db,
      "SELECT COUNT(*) AS n FROM mail_outbox WHERE created_at>?",
      now - 3_600_000,
    ) >= l.maxPerHour
  )
    return { status: "dropped", reason: "queue-full" };
  // A newer link of the same kind replaces older ones that were never sent,
  // so a user who asks again does not receive several stale links.
  db.prepare(
    `UPDATE mail_outbox SET status='cancelled', ${CLEAR_BODIES} WHERE user_id=? AND kind=? AND status='queued'`,
  ).run(input.userId, input.kind);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO mail_outbox(id,user_id,kind,recipient_key,to_address,subject,text_body,html_body,status,attempts,created_at,expires_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,'queued',0,?,?,?)",
  ).run(
    id,
    input.userId,
    input.kind,
    key,
    input.to,
    input.subject,
    input.text,
    input.html,
    now,
    now + l.deliveryWindowMs,
    now,
  );
  return { status: "queued", id };
}

/* ------------------------------------------------------------------ */
/* Enqueue (request side)                                             */
/* ------------------------------------------------------------------ */

/**
 * True only when THIS async call chain is inside the transaction Better Auth
 * opened on the auth connection. Better Auth records that per async context
 * (AsyncLocalStorage), so a concurrent request cannot be mistaken for it, and
 * the auth connection is held exclusively by the transaction's owner until it
 * ends. `isTransaction` alone would be wrong: it is true whenever ANY request
 * has a transaction open on the shared handle.
 */
async function insideOwnAuthTransaction(): Promise<boolean> {
  try {
    const storage = await getCurrentDBAdapterAsyncLocalStorage();
    const store = storage.getStore() as
      | { isTransactionActive?: boolean }
      | undefined;
    return store?.isTransactionActive === true && getAuthDatabase().isTransaction;
  } catch {
    return false;
  }
}

export async function enqueueMail(input: MailInput): Promise<EnqueueResult> {
  const result = (await insideOwnAuthTransaction())
    ? // The sign-up transaction already holds the write gate and the SQLite
      // write lock on the auth connection: insert there, and take no gate.
      insertMailLocked(getAuthDatabase(), input)
    : await runWriteTransaction((db) => insertMailLocked(db, input));
  if (result.status === "queued") kickLocalCapture();
  else console.warn(`Account mail not queued (${result.reason}).`);
  return result;
}

type Recipient = { id: string; email: string };

export function queueVerificationEmail(user: Recipient, url: string) {
  return enqueueMail({
    userId: user.id,
    kind: "verify-email",
    ...verificationMessage(user.email, url),
  });
}

export function queuePasswordResetEmail(user: Recipient, url: string) {
  return enqueueMail({
    userId: user.id,
    kind: "reset-password",
    ...passwordResetMessage(user.email, url),
  });
}

/* ------------------------------------------------------------------ */
/* Worker side                                                        */
/* ------------------------------------------------------------------ */

/**
 * Expires undeliverable rows, fails rows that exhausted their attempts while
 * "sending" (worker died), and deletes old metadata. Bodies and addresses are
 * cleared whenever a row stops being deliverable. Caller holds a write
 * transaction.
 */
export function sweepMailLocked(db: DatabaseSync, now: number): void {
  const l = mailLimits();
  db.prepare(
    `UPDATE mail_outbox SET status='expired', ${CLEAR_BODIES} WHERE status IN ('queued','sending') AND expires_at<=?`,
  ).run(now);
  db.prepare(
    `UPDATE mail_outbox SET status='failed', last_error_code=COALESCE(last_error_code,'lease'), ${CLEAR_BODIES} WHERE status='sending' AND lease_until<? AND attempts>=?`,
  ).run(now, l.maxAttempts);
  db.prepare(
    "DELETE FROM mail_outbox WHERE status IN ('sent','expired','failed','cancelled') AND created_at<?",
  ).run(now - l.terminalRetentionMs);
}

export type ClaimedMail = {
  id: string;
  lease: number;
  attempts: number;
  message: Message;
};

type BodyRow = {
  to_address: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  attempts: number;
};

/** Claims the next due message (or one whose worker died). Caller holds a write transaction. */
export function claimNextMailLocked(
  db: DatabaseSync,
  now: number,
): ClaimedMail | null {
  const l = mailLimits();
  sweepMailLocked(db, now);
  const row = db
    .prepare(
      "SELECT id FROM mail_outbox WHERE expires_at>? AND ((status='queued' AND next_attempt_at<=?) OR (status='sending' AND lease_until<?)) ORDER BY next_attempt_at ASC, created_at ASC LIMIT 1",
    )
    .get(now, now, now) as { id: string } | undefined;
  if (!row) return null;
  const lease = now + l.leaseMs;
  db.prepare(
    "UPDATE mail_outbox SET status='sending', attempts=attempts+1, lease_until=?, last_attempt_at=? WHERE id=?",
  ).run(lease, now, row.id);
  const body = db
    .prepare(
      "SELECT to_address, subject, text_body, html_body, attempts FROM mail_outbox WHERE id=?",
    )
    .get(row.id) as BodyRow;
  if (
    !body.to_address ||
    !body.subject ||
    body.text_body === null ||
    body.html_body === null
  ) {
    db.prepare(
      `UPDATE mail_outbox SET status='failed', last_error_code='empty', ${CLEAR_BODIES} WHERE id=?`,
    ).run(row.id);
    return null;
  }
  return {
    id: row.id,
    lease,
    attempts: body.attempts,
    message: {
      to: body.to_address,
      subject: body.subject,
      text: body.text_body,
      html: body.html_body,
    },
  };
}

export type MailOutcome =
  | { kind: "sent" }
  | { kind: "failed"; code: string; permanent: boolean }
  /**
   * The worker is shutting down and cancelled this send. Not a delivery
   * failure: the message goes straight back to `queued` and the attempt the
   * claim counted is given back. (If the relay had already received the whole
   * message it may still deliver it: the at-least-once caveat is unchanged.)
   */
  | { kind: "released" };

/** Delay before the next attempt after `attempts` attempts have been made. */
export function backoffMs(attempts: number): number {
  const l = mailLimits();
  const base = Math.min(
    l.backoffCapMs,
    l.backoffBaseMs * 4 ** Math.max(0, attempts - 1),
  );
  return Math.ceil(base * (1 + Math.random() * 0.1));
}

/**
 * Records the outcome of a claimed message. Guarded by status and the exact
 * lease, so a message that expired, was superseded, was deleted with its
 * account, or was re-claimed after a lapsed lease records nothing.
 */
export function finishMailLocked(
  db: DatabaseSync,
  id: string,
  lease: number,
  outcome: MailOutcome,
  now: number,
): boolean {
  const l = mailLimits();
  if (outcome.kind === "sent") {
    const done = db
      .prepare(
        `UPDATE mail_outbox SET status='sent', sent_at=?, last_error_code=NULL, ${CLEAR_BODIES} WHERE id=? AND status='sending' AND lease_until=?`,
      )
      .run(now, id, lease);
    return Number(done.changes) === 1;
  }
  if (outcome.kind === "released") {
    // Same guard as every outcome: status and the exact lease. The body and
    // address stay (the message is still deliverable); expiry still applies.
    const done = db
      .prepare(
        "UPDATE mail_outbox SET status='queued', attempts=MAX(attempts-1,0), last_error_code='shutdown', next_attempt_at=?, lease_until=NULL WHERE id=? AND status='sending' AND lease_until=?",
      )
      .run(now, id, lease);
    return Number(done.changes) === 1;
  }
  const row = db
    .prepare(
      "SELECT attempts FROM mail_outbox WHERE id=? AND status='sending' AND lease_until=?",
    )
    .get(id, lease) as { attempts: number } | undefined;
  if (!row) return false;
  if (outcome.permanent || row.attempts >= l.maxAttempts) {
    db.prepare(
      `UPDATE mail_outbox SET status='failed', last_error_code=?, ${CLEAR_BODIES} WHERE id=?`,
    ).run(outcome.code, id);
  } else {
    db.prepare(
      "UPDATE mail_outbox SET status='queued', last_error_code=?, next_attempt_at=?, lease_until=NULL WHERE id=?",
    ).run(outcome.code, now + backoffMs(row.attempts), id);
  }
  return true;
}

/**
 * How long a delivery that ignores the abort signal may keep the worker after
 * the deadline. The real SMTP path (mail.ts `sendOverSmtp`) closes its own
 * connection on abort and settles within milliseconds; this backstop exists
 * only so a non-cooperating `send` (a test seam) cannot hold the worker. It is
 * NOT how real sends are cancelled.
 */
export const ABORT_GRACE_MS = 3_000;
/** Pause between outcome-record tries (kept short once shutdown has started). */
const RECORD_SLEEP_MS = 500;
const SHUTDOWN_RECORD_SLEEP_MS = 250;

/**
 * Worst case, in milliseconds, between a shutdown request and the worker having
 * done everything it will do (record the cancelled message, or give up and
 * leave it to lease recovery). Every term is a configured bound:
 *  - during a claim: the claim's write budget, then one shutdown record;
 *  - during a send: the abort grace, then one shutdown record;
 *  - during a normal outcome record: the try in flight, then the shortened
 *    shutdown tries.
 * compose.yaml's `stop_grace_period` and `shutdownExitMs` must stay above it
 * (tests/mailWorker.test.ts asserts this).
 */
export function mailShutdownWorstCaseMs(): number {
  const l = mailLimits();
  const shutdownRecord =
    (l.shutdownRecordRetries + 1) * l.shutdownRecordAcquireMs +
    l.shutdownRecordRetries * SHUTDOWN_RECORD_SLEEP_MS;
  const duringClaim = DEFAULT_WRITE_ACQUIRE_MS + shutdownRecord;
  const duringSend = ABORT_GRACE_MS + shutdownRecord;
  const duringRecord =
    l.recordAcquireMs + RECORD_SLEEP_MS + shutdownRecord;
  return Math.max(duringClaim, duringSend, duringRecord);
}

/**
 * Longest single bounded step the worker loop can sit in without making
 * progress (one send with its abort grace, one claim, one record try). The
 * heartbeat stops reporting when the loop is silent for longer than this plus
 * a margin (see mailHealth.ts).
 */
export function mailStepBoundMs(): number {
  const l = mailLimits();
  return Math.max(
    l.sendTimeoutMs + ABORT_GRACE_MS,
    DEFAULT_WRITE_ACQUIRE_MS,
    l.recordAcquireMs + RECORD_SLEEP_MS,
  );
}

/**
 * Runs one delivery under a hard deadline by ABORTING it: at the deadline (or
 * at shutdown) the signal fires, the delivery destroys its own connection, and
 * we wait for it to settle. A Promise.race alone would leave the send running;
 * here the race is only the post-abort backstop above.
 *
 * A shutdown abort that stops the send is reported as EMAIL_SHUTDOWN so the
 * caller can release the message instead of counting a failed attempt. If the
 * send had already succeeded when shutdown arrived, it is reported as sent.
 */
async function deliverWithDeadline(
  send: (message: Message, id: string, signal: AbortSignal) => Promise<void>,
  message: Message,
  id: string,
  deadlineMs: number,
  shutdown?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  // An object, not a local: the abort callbacks assign it, and TypeScript
  // would otherwise narrow a plain `let` to `null` where it is read below.
  const state: { cause: "deadline" | "shutdown" | null } = { cause: null };
  const abort = (why: "deadline" | "shutdown") => {
    if (state.cause) return;
    state.cause = why;
    controller.abort();
  };
  const deadline = setTimeout(() => abort("deadline"), deadlineMs);
  const onShutdown = () => abort("shutdown");
  let backstop: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        backstop = setTimeout(
          () =>
            reject(
              Object.assign(new Error("send did not stop"), {
                code: "EMAIL_SEND_TIMEOUT",
              }),
            ),
          ABORT_GRACE_MS,
        );
      },
      { once: true },
    );
  });
  // Handled by the race below; this only keeps a late rejection from being
  // reported as unhandled if `send` throws before the race starts.
  abandoned.catch(() => {});
  if (shutdown?.aborted) onShutdown();
  else shutdown?.addEventListener("abort", onShutdown, { once: true });
  try {
    const work = send(message, id, controller.signal);
    await Promise.race([work, abandoned]);
  } catch (error) {
    if (state.cause === "shutdown")
      throw Object.assign(new Error("worker shutdown"), {
        code: "EMAIL_SHUTDOWN",
      });
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(backstop);
    shutdown?.removeEventListener("abort", onShutdown);
  }
}

export type ProcessOptions = {
  /**
   * Test seam: replaces SMTP/file delivery. Receives the stable message id and
   * an AbortSignal that fires at the send deadline or at shutdown; a real
   * sender must close its connection when it fires.
   */
  send?: (message: Message, id: string, signal: AbortSignal) => Promise<void>;
  /**
   * Worker shutdown. Once aborted: nothing new is claimed, a send in flight is
   * cancelled through the same signal that carries the deadline (the SMTP
   * socket is destroyed), and the message is released back to `queued` with
   * the short shutdown record budget. If even that cannot be recorded in time
   * the row stays `sending` and the lease returns it to the queue.
   */
  shutdown?: AbortSignal;
  /** Called at the start and end of every bounded step (feeds the heartbeat). */
  onProgress?: () => void;
};

/**
 * Claims and delivers at most one message. SMTP I/O happens strictly outside
 * any database transaction. Returns false when nothing was due (or shutdown has
 * started). A thrown contention error means nothing was claimed; the caller
 * simply tries again.
 */
export async function processNextMail(
  options: ProcessOptions = {},
): Promise<boolean> {
  const { shutdown } = options;
  const progress = () => options.onProgress?.();
  if (shutdown?.aborted) return false;
  progress();
  const claim = await runWriteTransaction((db) =>
    claimNextMailLocked(db, Date.now()),
  );
  progress();
  if (!claim) return false;
  const l = mailLimits();
  let outcome: MailOutcome;
  if (shutdown?.aborted) {
    // Shutdown arrived while the claim was waiting for the write lock: the
    // message was never handed to SMTP.
    outcome = { kind: "released" };
  } else {
    try {
      await deliverWithDeadline(
        options.send ?? deliverMessage,
        claim.message,
        claim.id,
        l.sendTimeoutMs,
        shutdown,
      );
      outcome = { kind: "sent" };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "EMAIL_SHUTDOWN") {
        outcome = { kind: "released" };
        console.error(
          `Account mail attempt ${claim.attempts} interrupted by shutdown for message ${claim.id}.`,
        );
      } else {
        const failure = classifyMailError(error);
        outcome = { kind: "failed", ...failure };
        console.error(
          `Account mail attempt ${claim.attempts} failed (${failure.code}) for message ${claim.id}.`,
        );
      }
    }
  }
  progress();
  for (let attempt = 0; ; attempt++) {
    // Re-read every try: shutdown can begin while earlier tries are failing.
    const stopping = shutdown?.aborted === true;
    const rl = mailLimits();
    try {
      await runWriteTransaction(
        (db) => finishMailLocked(db, claim.id, claim.lease, outcome, Date.now()),
        {
          acquireTimeoutMs: stopping
            ? rl.shutdownRecordAcquireMs
            : rl.recordAcquireMs,
        },
      );
      progress();
      return true;
    } catch (error) {
      // Judged again here: shutdown may have begun while this try waited.
      const stoppingNow = shutdown?.aborted === true;
      const budget = stoppingNow ? rl.shutdownRecordRetries : rl.recordRetries;
      if (!isWriteContention(error) || attempt >= budget) {
        // The message stays "sending" and is returned to the queue when its
        // lease lapses: a duplicate is possible, a loss is not.
        console.error(
          `Could not record the outcome of account mail ${claim.id}; it may be sent again.`,
        );
        progress();
        return true;
      }
      progress();
      await sleep(stoppingNow ? SHUTDOWN_RECORD_SLEEP_MS : RECORD_SLEEP_MS);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Worker heartbeat, counts, local capture                            */
/* ------------------------------------------------------------------ */

export async function touchMailHeartbeat(): Promise<void> {
  await runWriteTransaction(
    (db) =>
      db
        .prepare(
          "INSERT INTO mail_worker_state(id,heartbeat_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at",
        )
        .run(Date.now()),
    { acquireTimeoutMs: 5000 },
  );
}

/** Milliseconds since the mail worker last reported in, or null if it never has. Read-only. */
export function mailHeartbeatAgeMs(): number | null {
  try {
    const row = getDatabase()
      .prepare("SELECT heartbeat_at FROM mail_worker_state WHERE id=1")
      .get() as { heartbeat_at: number } | undefined;
    return row ? Date.now() - row.heartbeat_at : null;
  } catch {
    return null;
  }
}

/** Counts only: never addresses, bodies or tokens. For operators. */
export function mailQueueStats() {
  const db = getDatabase();
  const byStatus = db
    .prepare("SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status")
    .all() as { status: string; n: number }[];
  const oldest = db
    .prepare(
      "SELECT MIN(created_at) AS t FROM mail_outbox WHERE status IN ('queued','sending')",
    )
    .get() as { t: number | null };
  return {
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    oldestPendingAgeMs: oldest.t === null ? null : Date.now() - oldest.t,
    workerHeartbeatAgeMs: mailHeartbeatAgeMs(),
  };
}

let kickTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
let again = false;

/**
 * Development convenience only (no SMTP_URL and not a public deployment): the
 * web process drains its own queue into the private local capture folder, so
 * `npm run dev` and the tests work without a mail worker. The capture is
 * therefore EVENTUAL (tens of milliseconds after commit); readers must poll.
 * With SMTP configured this does nothing: only the mail worker ever speaks SMTP.
 */
export function kickLocalCapture(): void {
  if (!usesLocalCapture()) return;
  if (draining) {
    again = true;
    return;
  }
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void drainLocalCapture();
  }, 15);
  kickTimer.unref?.();
}

async function drainLocalCapture(): Promise<void> {
  draining = true;
  let errors = 0;
  try {
    do {
      again = false;
      for (let i = 0; i < 50; i++) {
        try {
          if (!(await processNextMail())) break;
        } catch {
          if (++errors > 5) return;
          await sleep(200);
          again = true;
          break;
        }
      }
    } while (again);
  } finally {
    draining = false;
  }
}

/**
 * TEST SEAM (build 015 revision 3); production code never calls it. Resolves
 * once the local capture is observed idle: no pending kick timer AND no drain
 * running. It only READS those two flags: it clears no timer, disables nothing,
 * changes no delay and never takes the write gate. A drain that is waiting for
 * the gate therefore keeps the flags busy, and the wait ends in a rejection at
 * the cap rather than hiding the writer. Do not call it while holding the gate
 * that the drain needs: it would wait out the cap. With SMTP configured or in a
 * public deployment nothing is ever scheduled, so it resolves at once.
 */
export async function settleLocalCapture(
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  // Validated BEFORE the idle flags are read: NaN would survive min/max and
  // make the deadline comparison never true, so a blocked drain could wait forever.
  for (const [name, value] of [
    ["timeoutMs", options.timeoutMs],
    ["pollMs", options.pollMs],
  ] as const)
    if (value !== undefined && !(typeof value === "number" && Number.isFinite(value)))
      throw new RangeError(`settleLocalCapture ${name} must be a finite number.`);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5_000, 1), 30_000);
  const pollMs = Math.min(Math.max(options.pollMs ?? 5, 1), 100);
  const end = Date.now() + timeoutMs;
  while (kickTimer !== null || draining) {
    if (Date.now() >= end)
      throw new Error("Local mail capture did not settle in time.");
    await sleep(pollMs);
  }
}
