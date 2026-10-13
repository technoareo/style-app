import { toNextJsHandler } from "better-auth/next-js";
import { getReadyAuth } from "../../../../server/auth";
import { readBoundedBody } from "../../../../server/boundedBody";
import { runWithContention } from "../../../../server/contention";
import { limits } from "../../../../server/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const delegate = toNextJsHandler(async (request: Request) => {
  const auth = await getReadyAuth();
  return auth.handler(request);
});

const BUSY_RETRY_SECONDS = 5;
function busyResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Style Studio is busy right now. Please try again in a few seconds.",
      code: "busy",
      retryAfterSeconds: BUSY_RETRY_SECONDS,
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "Cache-Control": "private, no-store",
        "Retry-After": String(BUSY_RETRY_SECONDS),
      },
    },
  );
}

/** Fixed, private JSON answer for body-read refusals (never reaches the outer catch). */
function fixedJson(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

function withSafety(fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      if (request.body && !["GET", "HEAD"].includes(request.method)) {
        // Shared bounded reader: 32 KiB cap and an absolute total deadline,
        // both enforced before any auth, contention or database work.
        const read = await readBoundedBody(request, {
          maxBytes: 32_768,
          timeoutMs: limits().bodyReadTimeoutMs,
          route: "auth",
        });
        if (read.status === "too_large")
          return fixedJson(413, "Account request is too large.");
        if (read.status === "timeout")
          return fixedJson(408, "The request took too long. Please try again.");
        if (read.status === "aborted")
          return fixedJson(400, "The request was cancelled.");
        request = new Request(request, {
          body: read.status === "ok" ? read.bytes.toString("utf8") : "",
        });
      }
      const outcome = await runWithContention(() => fn(request));
      if (outcome.error !== undefined) {
        if (outcome.contended) return busyResponse();
        throw outcome.error;
      }
      response = outcome.value as Response;
      // Better Auth reports a refused database lock as a generic 500. The
      // lock was refused before the work started (see contention.ts), so
      // nothing was written, no token was consumed, and the identical request
      // can be repeated: say so.
      if (outcome.contended && response.status >= 500) return busyResponse();
    } catch {
      // Config/migration failures land here (e.g. missing secret or SMTP in
      // public mode). Never surface the underlying error to the client.
      response = new Response(
        JSON.stringify({ error: "Authentication is temporarily unavailable." }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export const GET = withSafety(delegate.GET);
export const POST = withSafety(delegate.POST);
export const PUT = withSafety(delegate.PUT);
export const PATCH = withSafety(delegate.PATCH);
export const DELETE = withSafety(delegate.DELETE);
