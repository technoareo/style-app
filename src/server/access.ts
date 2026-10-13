import { NextRequest, NextResponse } from "next/server";
import { getReadyAuth } from "./auth";
import { readBoundedBody } from "./boundedBody";
import type { UploadRoute } from "./uploadMetrics";
import { isWriteContention, runWriteTransaction } from "./writeTransaction";
/** Optional machine-readable detail merged into the JSON error body. */
export type RequestErrorExtra = {
  /** Seconds the client should wait before retrying (also sent as Retry-After). */
  retryAfterSeconds?: number;
  code?: string;
  [key: string]: unknown;
};
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: RequestErrorExtra,
  ) {
    super(message);
  }
}
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export const appOrigin = () =>
  new URL(process.env.APP_URL || "http://127.0.0.1:3000").origin;
// Cancelling or discarding the caller's own analysis must keep working when the
// ordinary change quota is exhausted, so it has a separate, much looser bound.
const CANCEL_PER_MINUTE = 300;
const cancelWindows = new Map<string, { window: number; count: number }>();
function takeCancelSlot(userId: string): void {
  const window = Math.floor(Date.now() / 60000);
  const entry = cancelWindows.get(userId);
  if (!entry || entry.window !== window) {
    if (cancelWindows.size > 5000) cancelWindows.clear();
    cancelWindows.set(userId, { window, count: 1 });
    return;
  }
  entry.count++;
  if (entry.count > CANCEL_PER_MINUTE)
    throw new RequestError(429, "Too many cancel requests. Wait a minute.", {
      retryAfterSeconds: 30,
    });
}

export type AccountOptions = {
  /**
   * false: a state-changing request that is exempt from the ordinary
   * 120-changes-per-minute counter (used for cancel/discard). Origin, session
   * and account-binding checks still apply; a separate loose bound is used.
   */
  quota?: boolean;
};

export async function account(
  req: NextRequest,
  mutation = false,
  options: AccountOptions = {},
) {
  if (mutation && req.headers.get("origin") !== appOrigin())
    throw new RequestError(403, "Open this action from Style Studio.");
  const auth = await getReadyAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) throw new RequestError(401, "Please sign in to continue.");
  if (mutation && req.headers.get("x-style-account") !== session.user.id)
    throw new RequestError(409, "Your account changed. Reload before saving.");
  if (mutation && options.quota === false) {
    takeCancelSlot(session.user.id);
    return session.user;
  }
  if (mutation) {
    const window = Math.floor(Date.now() / 60000);
    const row = await runWriteTransaction(
      (db) =>
        db
          .prepare(
            "INSERT INTO mutation_limits(user_id,window_start,count) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET count=CASE WHEN mutation_limits.window_start=excluded.window_start THEN mutation_limits.count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count",
          )
          .get(session.user.id, window) as { count: number },
    );
    if (row.count > 120)
      throw new RequestError(
        429,
        "Please wait a minute before making more changes.",
      );
  }
  return session.user;
}
export async function readJson(
  req: NextRequest,
  max = 3_000_000,
  options: { timeoutMs?: number; cancelGraceMs?: number; route?: UploadRoute } = {},
) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new RequestError(415, "Use a JSON request.");
  if (!req.body) throw new RequestError(400, "Request is empty.");
  // Always bounded: an absolute total deadline (limits().bodyReadTimeoutMs
  // unless a caller passes a positive one), so a stalled or trickling upload
  // can never hold a request, or a processing slot, open indefinitely.
  const read = await readBoundedBody(req, {
    maxBytes: max,
    timeoutMs: options.timeoutMs,
    cancelGraceMs: options.cancelGraceMs,
    route: options.route,
  });
  if (read.status === "timeout")
    throw new RequestError(408, "The upload took too long. Please try again.");
  if (read.status === "aborted")
    throw new RequestError(400, "The request was cancelled.");
  if (read.status === "too_large")
    throw new RequestError(413, "This request is too large.");
  if (read.status === "empty") throw new RequestError(400, "Request is empty.");
  try {
    return JSON.parse(read.bytes.toString());
  } catch {
    throw new RequestError(400, "The request could not be read.");
  }
}
export function errorResponse(error: unknown) {
  const known = error instanceof RequestError;
  // A refused write lock (before the body ran) is retryable and said so.
  if (!known && isWriteContention(error))
    return NextResponse.json(
      {
        error: "Style Studio is busy right now. Please try again in a few seconds.",
        code: "busy",
        retryAfterSeconds: 5,
      },
      { status: 503, headers: { ...privateHeaders, "Retry-After": "5" } },
    );
  const extra = known ? error.extra : undefined;
  return NextResponse.json(
    {
      error: known
        ? error.message
        : "This action is temporarily unavailable. Please try again.",
      ...(extra ?? {}),
    },
    {
      status: known ? error.status : 503,
      headers: {
        ...privateHeaders,
        ...(extra?.retryAfterSeconds
          ? { "Retry-After": String(Math.ceil(extra.retryAfterSeconds)) }
          : {}),
      },
    },
  );
}
