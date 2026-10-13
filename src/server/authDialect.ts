import type { DatabaseSync } from "node:sqlite";
import { NodeSqliteDialect } from "@better-auth/kysely-adapter/node-sqlite-dialect";
import type {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  QueryResult,
  TransactionSettings,
} from "kysely";
import { isSqliteBusy, retryBusy, WRITE_POLL_MAX_MS } from "./sqliteRetry";
import { noteContention } from "./contention";
import {
  currentLockObserver,
  detailOf,
  monotonicNow,
  ms,
  notifyAcquire,
  notifyHold,
  type AcquireEvent,
  type LockObserver,
} from "./lockDiagnostics";
import {
  acquireWriteGate,
  WriteGateError,
  writeGateQueueLength,
} from "./writeGate";

/**
 * Kysely dialect for Better Auth over node:sqlite. It replaces the stock
 * adapter's transaction handling (a plain, deferred BEGIN on a handle shared
 * with synchronous code) with:
 *
 *  1. BEGIN IMMEDIATE when Kysely begins the transaction. The write lock is
 *     taken before the body's first read, so read-then-write sequences keep
 *     full transaction semantics: two consumers of one reset/verification
 *     token cannot both read it as valid, and no read-to-write upgrade can
 *     fail with SQLITE_BUSY_SNAPSHOT (which ignores busy_timeout).
 *  2. The process-wide write gate (writeGate.ts), taken before BEGIN and held
 *     until COMMIT/ROLLBACK, so synchronous writers in this process queue
 *     (boundedly) behind this async transaction instead of parking the event
 *     loop on a lock only this event loop can release.
 *  3. Bounded asynchronous lock acquisition. BEGIN IMMEDIATE is retried with
 *     async backoff within the REMAINING part of one `acquireTimeoutMs` budget
 *     that also paid for the gate wait (build 015). Any autocommit statement
 *     that fails with SQLITE_BUSY is retried until its own `acquireTimeoutMs`;
 *     the native busy wait on this
 *     connection is short (see getAuthDatabase). A failed BEGIN has no
 *     effects, and a statement that failed with SQLITE_BUSY did not run, so
 *     both are safe to replay. Statements inside an open transaction and the
 *     transaction body are never replayed.
 *
 * Cost, stated plainly: Better Auth runs the whole sign-up handler,
 * including password hashing, inside this transaction, so the write lock is
 * held for the hash duration (~100s of ms). Other writers wait within the
 * bounds above. Mail delivery is deliberately kept out (see auth.ts).
 */

export type ImmediateDialectOptions = {
  /** Upper bound on async waiting for the gate and the SQLite write lock. */
  acquireTimeoutMs?: number;
  /** First backoff step; doubles up to 250 ms, plus jitter. */
  baseDelayMs?: number;
};

type Retry = <T>(
  op: () => T | Promise<T>,
  canRetry?: () => boolean,
  /** Budget for this call; defaults to the full acquisition timeout. */
  timeoutMs?: number,
) => Promise<T>;

function makeRetry(options: ImmediateDialectOptions): Retry {
  return (op, canRetry, timeoutMs) =>
    retryBusy(op, {
      timeoutMs: timeoutMs ?? options.acquireTimeoutMs ?? 10_000,
      baseDelayMs: options.baseDelayMs ?? 20,
      maxDelayMs: WRITE_POLL_MAX_MS,
      canRetry,
    });
}

class AuthConnection implements DatabaseConnection {
  began = false;
  #release: (() => void) | null = null;
  #observer: LockObserver | null = null;
  #holdStartedAt: number | null = null;

  constructor(
    readonly inner: DatabaseConnection,
    private readonly database: DatabaseSync,
    private readonly retry: Retry,
    private readonly acquireTimeoutMs: number,
  ) {}

  /**
   * Gate, then BEGIN IMMEDIATE (bounded, async). Releases the gate on failure.
   * ONE deadline covers both waits: time spent in the gate queue is taken from
   * the SQLite budget, so gate plus SQLite acquisition never exceeds
   * `acquireTimeoutMs` (plus one BEGIN attempt, as on the write path).
   */
  async begin(): Promise<void> {
    const t0 = Date.now();
    const deadline = t0 + this.acquireTimeoutMs;
    // Diagnostics only (lockDiagnostics.ts); never feeds the control flow.
    const observer = currentLockObserver();
    const startedAt = monotonicNow();
    const queueDepth = writeGateQueueLength();
    let release: () => void;
    const gateRequestedAt = monotonicNow();
    try {
      release = await acquireWriteGate(this.acquireTimeoutMs);
    } catch (error) {
      // Gate wait exhausted: the transaction never began.
      noteContention("auth-gate");
      const failedAt = monotonicNow();
      const waited = ms(failedAt - gateRequestedAt);
      notifyAcquire(observer, {
        path: "auth",
        ok: false,
        outcome:
          error instanceof WriteGateError
            ? error.reason === "full"
              ? "gate-full"
              : "gate-timeout"
            : "error",
        budgetMs: this.acquireTimeoutMs,
        // The auth connection exists before a transaction can begin.
        initializationMs: 0,
        gateMs: waited,
        sqliteMs: 0,
        totalMs: ms(failedAt - startedAt),
        attempts: 0,
        queueDepth,
      });
      throw error;
    }
    const gateMs = Date.now() - t0;
    const gateAcquiredAt = monotonicNow();
    let attempts = 0;
    // Read INSIDE the retried call, right after exec returns (see the write
    // path): the hold starts when the lock was taken, not after the microtask
    // hop back to this function.
    let beganAt = 0;
    try {
      await this.retry(
        () => {
          attempts++;
          const began = this.database.exec("BEGIN IMMEDIATE");
          beganAt = monotonicNow();
          return began;
        },
        undefined,
        // The remaining budget; 0 still allows the single first attempt.
        Math.max(0, deadline - Date.now()),
      );
    } catch (error) {
      release();
      if (isSqliteBusy(error)) noteContention("auth-begin");
      const failedAt = monotonicNow();
      const event: AcquireEvent = {
        path: "auth",
        ok: false,
        outcome: isSqliteBusy(error) ? "busy" : "error",
        budgetMs: this.acquireTimeoutMs,
        initializationMs: 0,
        gateMs: ms(gateAcquiredAt - gateRequestedAt),
        sqliteMs: ms(failedAt - gateAcquiredAt),
        totalMs: ms(failedAt - startedAt),
        attempts,
        queueDepth,
      };
      notifyAcquire(observer, event);
      // Elapsed split for diagnosing starvation versus a stuck holder. The
      // original error object and type are preserved.
      if (typeof error === "object" && error !== null)
        Object.assign(error, {
          // The monotonic detail first; then the two ORIGINAL (pre-011)
          // wall-clock fields, written last so their names keep their
          // original meaning for existing readers.
          acquire: {
            ...detailOf(event),
            gateMs,
            sqliteMs: Date.now() - t0 - gateMs,
          },
        });
      throw error;
    }
    this.#release = release;
    this.began = true;
    this.#observer = observer;
    this.#holdStartedAt = beganAt;
    notifyAcquire(observer, {
      path: "auth",
      ok: true,
      outcome: "acquired",
      budgetMs: this.acquireTimeoutMs,
      initializationMs: 0,
      gateMs: ms(gateAcquiredAt - gateRequestedAt),
      sqliteMs: ms(beganAt - gateAcquiredAt),
      totalMs: ms(beganAt - startedAt),
      attempts,
      queueDepth,
    });
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    try {
      return await this.retry(
        () => this.inner.executeQuery<R>(query),
        // Never replay a statement inside an open transaction.
        () => !this.database.isTransaction,
      );
    } catch (error) {
      // A refused autocommit statement did not run (only outside a
      // transaction; inside one, the transaction's own error surfaces).
      if (isSqliteBusy(error) && !this.database.isTransaction)
        noteContention("auth-statement");
      throw error;
    }
  }

  streamQuery<R>(
    query: CompiledQuery,
    chunkSize = 100,
  ): AsyncIterableIterator<QueryResult<R>> {
    return this.inner.streamQuery<R>(query, chunkSize);
  }

  /** Ends the transaction: COMMIT or ROLLBACK, then frees the write gate. */
  finish(commit: boolean): void {
    const wasBegan = this.began;
    this.began = false;
    const release = this.#release;
    this.#release = null;
    const observer = this.#observer;
    const holdStartedAt = this.#holdStartedAt;
    this.#observer = null;
    this.#holdStartedAt = null;
    let outcome: "commit" | "rollback" = commit ? "commit" : "rollback";
    try {
      if (wasBegan && this.database.isTransaction) {
        try {
          this.database.exec(commit ? "COMMIT" : "ROLLBACK");
        } catch (error) {
          outcome = "rollback";
          if (commit && this.database.isTransaction) {
            try {
              this.database.exec("ROLLBACK");
            } catch {
              // The original COMMIT failure is the one worth reporting.
            }
          }
          throw error;
        }
      }
    } finally {
      try {
        if (wasBegan && holdStartedAt !== null)
          notifyHold(observer, {
            path: "auth",
            holdMs: ms(monotonicNow() - holdStartedAt),
            outcome,
          });
      } catch {
        // Defence in depth: release() below must always run.
      }
      release?.();
    }
  }
}

class ImmediateNodeSqliteDialect extends NodeSqliteDialect {
  readonly #database: DatabaseSync;
  readonly #retry: Retry;
  readonly #timeout: number;

  constructor(database: DatabaseSync, options: ImmediateDialectOptions) {
    super({ database });
    this.#database = database;
    this.#retry = makeRetry(options);
    this.#timeout = options.acquireTimeoutMs ?? 10_000;
  }

  override createDriver(): Driver {
    const inner = super.createDriver();
    const database = this.#database;
    const retry = this.#retry;
    const timeout = this.#timeout;
    return {
      init: () => inner.init(),
      async acquireConnection() {
        const connection = await inner.acquireConnection();
        return new AuthConnection(connection, database, retry, timeout);
      },
      async beginTransaction(
        connection: DatabaseConnection,
        settings?: TransactionSettings,
      ) {
        void settings;
        await (connection as AuthConnection).begin();
      },
      async commitTransaction(connection: DatabaseConnection) {
        (connection as AuthConnection).finish(true);
      },
      async rollbackTransaction(connection: DatabaseConnection) {
        (connection as AuthConnection).finish(false);
      },
      async releaseConnection(connection: DatabaseConnection) {
        const auth = connection as AuthConnection;
        // Safety net: never leave a transaction or the gate held.
        if (auth.began) auth.finish(false);
        await inner.releaseConnection(auth.inner);
      },
      // The connection is owned by database.ts; Kysely must not close it.
      destroy: async () => {},
    };
  }
}

export function createImmediateSqliteDialect(
  database: DatabaseSync,
  options: ImmediateDialectOptions = {},
): NodeSqliteDialect {
  return new ImmediateNodeSqliteDialect(database, options);
}
