import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { ensureDatabaseReady, getAuthDatabase, getDataDir } from "./database";
import { createImmediateSqliteDialect } from "./authDialect";
import { assertMailConfigured } from "./mail";
import { queuePasswordResetEmail, queueVerificationEmail } from "./mailOutbox";

type AuthInstance = ReturnType<typeof betterAuth>;

/**
 * ONE budget for the two waits before an auth transaction starts (the
 * in-process gate, then the SQLite write lock; time spent in the gate queue
 * is deducted from the SQLite wait, build 015). Default 10 s; override with
 * STYLE_AUTH_LOCK_MS (100..60000). Running out means the work never started
 * and is reported as a retryable 503 (see api/auth route).
 */
function authLockBudgetMs(): number {
  const value = Number(process.env.STYLE_AUTH_LOCK_MS);
  return Number.isFinite(value) && value >= 100 && value <= 60_000
    ? Math.floor(value)
    : 10_000;
}

function isPublicDeployment(): boolean {
  return process.env.STYLE_PUBLIC_DEPLOYMENT === "true";
}

function resolveAppUrl(publicDeployment: boolean): string {
  const raw = process.env.APP_URL?.trim() || "http://127.0.0.1:3000";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_URL is not a valid URL: ${raw}`);
  }
  if (publicDeployment) {
    if (url.protocol !== "https:")
      throw new Error(
        "Public deployment requires APP_URL to use https:// (a TLS origin).",
      );
    if (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "0.0.0.0" ||
      url.hostname === "::1"
    )
      throw new Error(
        "Public deployment requires a canonical public APP_URL, not localhost/127.0.0.1.",
      );
  }
  return url.origin;
}

/**
 * AUTH_SECRET must be 32+ chars and is required for public deployment. For
 * local-only use we generate one and persist it under the private data dir
 * so sessions survive restarts; it is never printed.
 */
function resolveSecret(publicDeployment: boolean): string {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32)
      throw new Error("AUTH_SECRET must be at least 32 characters.");
    return fromEnv;
  }
  if (publicDeployment)
    throw new Error(
      "AUTH_SECRET (32+ characters) is required for public deployment.",
    );
  const dir = getDataDir();
  const file = path.join(dir, "auth-secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // No secret file yet; generate and persist one below.
  }
  const generated = randomBytes(32).toString("base64url");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, generated, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length < 32)
      throw new Error("Local account configuration is not ready.");
    return existing;
  }
  return generated;
}

async function build(): Promise<{
  auth: AuthInstance;
  options: BetterAuthOptions;
}> {
  const publicDeployment = isPublicDeployment();
  const appUrl = resolveAppUrl(publicDeployment);
  const secret = resolveSecret(publicDeployment);
  if (publicDeployment) assertMailConfigured();

  const options: BetterAuthOptions = {
    baseURL: appUrl,
    secret,
    // Dedicated connection + BEGIN IMMEDIATE transactions; see authDialect.ts
    // and docs/reviews/concurrency-005-notes.md.
    database: {
      dialect: createImmediateSqliteDialect(getAuthDatabase(), {
        acquireTimeoutMs: authLockBudgetMs(),
      }),
      type: "sqlite",
      transaction: true,
    },
    // Exact origin only; never derived from request Host headers.
    trustedOrigins: [appUrl],
    // The deletion ledger is written atomically by the user_deletion_ledger
    // trigger (database.ts), not by a post-delete hook.
    // No `advanced.backgroundTasks` handler on purpose. Better Auth then
    // AWAITS the mail callbacks below (and logs, never rethrows, their
    // failures). The callbacks only INSERT into the durable mail outbox, a
    // fast local write that must finish inside the sign-up transaction so a
    // queued row commits (or rolls back) with it. A sign-up can still end with
    // no mail (failed or silently capped enqueue). SMTP is never touched here; the
    // supervised mail worker sends (see src/server/mailOutbox.ts).
    advanced: {
      useSecureCookies: publicDeployment,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await queuePasswordResetEmail(user, url);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => {
        await queueVerificationEmail(user, url);
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    user: {
      deleteUser: {
        enabled: true,
      },
    },
    account: {
      // No social providers configured in this increment; keep linking off
      // rather than inherit the library's default-on behavior.
      accountLinking: {
        enabled: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 10,
      customRules: {
        "/get-session": false,
        "/send-verification-email": { window: 60, max: 3 },
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
      },
    },
  };

  const auth = betterAuth(options);
  return { auth, options };
}

let buildPromise: Promise<{
  auth: AuthInstance;
  options: BetterAuthOptions;
}> | null = null;

function getBuilt(): Promise<{
  auth: AuthInstance;
  options: BetterAuthOptions;
}> {
  if (!buildPromise) {
    buildPromise = build().catch((error) => {
      buildPromise = null;
      throw error;
    });
  }
  return buildPromise;
}

/** The configured Better Auth instance, built on first use. Does not by
 * itself guarantee migrations have run — use {@link getReadyAuth} for that. */
export async function getAuth(): Promise<AuthInstance> {
  const { auth } = await getBuilt();
  return auth;
}

let readyPromise: Promise<AuthInstance> | null = null;

/** The configured Better Auth instance after its schema and migrations are
 * confirmed ready. Safe to call concurrently; the readiness check runs once
 * per process. */
export function getReadyAuth(): Promise<AuthInstance> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const { auth, options } = await getBuilt();
      await ensureDatabaseReady(options);
      return auth;
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}
