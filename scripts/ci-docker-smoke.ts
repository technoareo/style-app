/**
 * Smoke test for the Docker CI job (see .github/workflows/ci.yml). Talks to the
 * app container over HTTP and to the bind-mounted data folder for the
 * development mail capture; the AI worker runs against a MOCK model
 * (deploy/ci/mock-ollama.mjs). Disposable account, loopback only, no real
 * email, no real model.
 *
 *   BASE_URL=http://127.0.0.1:3000 STYLE_DATA_DIR=/path/to/bind-mount tsx scripts/ci-docker-smoke.ts
 *
 * Not yet run on a Docker host by the author.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const base = process.env.BASE_URL || "http://127.0.0.1:3000";
const configuredDataDir = process.env.STYLE_DATA_DIR;
if (!configuredDataDir)
  throw new Error("STYLE_DATA_DIR (the bind-mounted data folder) is required.");
// A const string (not narrowed `string | undefined`) so closures keep the type.
const dataDir: string = configuredDataDir;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const call = (route: string, init: RequestInit = {}) =>
  fetch(base + route, {
    redirect: "manual",
    ...init,
    headers: { origin: base, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(60_000),
  });

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined | false>,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const email = `docker-${Date.now()}@example.test`;
  const password = "Docker smoke passphrase 33!";
  const signUp = await call("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Docker smoke", callbackURL: "/" }),
  });
  expect(signUp.status === 200, `sign-up returned ${signUp.status}`);

  // The app container (or the mail worker) captures the message into the bind mount.
  const link = await until("the verification mail", 60_000, async () => {
    const dir = path.join(dataDir, "mail-outbox");
    if (!existsSync(dir)) return undefined;
    for (const file of readdirSync(dir)) {
      try {
        const mail = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
        if (mail.to === email) return String(mail.text).split(": ").slice(1).join(": ");
      } catch {
        // half-written
      }
    }
    return undefined;
  });
  const verified = await call(new URL(link).pathname + new URL(link).search);
  expect(verified.status < 400, `verification returned ${verified.status}`);

  const signIn = await call("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status === 200, `sign-in returned ${signIn.status}`);
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const userId = (await signIn.json()).user?.id as string;
  const authed = { cookie, "x-style-account": userId };

  // The AI worker's heartbeat and the (mock) model must both be visible.
  await until("the analysis service to report ready", 90_000, async () => {
    const r = await call("/api/analyze", { headers: authed });
    return r.status === 200 && (await r.json()).configured === true;
  });

  const image = await sharp({
    create: { width: 400, height: 400, channels: 3, background: "#ffffff" },
  })
    .jpeg()
    .toBuffer();
  const submit = await call("/api/analyze", {
    method: "POST",
    headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({
      image: `data:image/jpeg;base64,${image.toString("base64")}`,
      consent: true,
    }),
  });
  expect(submit.status === 202, `analyze returned ${submit.status}`);
  const job = (await submit.json()) as { id: string };

  const done = await until("the analysis job to finish", 120_000, async () => {
    const r = await call(`/api/analysis-jobs/${job.id}`, { headers: authed });
    const body = (await r.json()) as { status: string; result?: { items: unknown[] } };
    if (body.status === "failed") throw new Error("The mock analysis failed.");
    return body.status === "completed" ? body : undefined;
  });
  expect(done.result?.items.length === 1, "expected the mock model's single garment");

  const discard = await call(`/api/analysis-jobs/${job.id}`, {
    method: "DELETE",
    headers: authed,
  });
  expect(discard.status === 200, `discard returned ${discard.status}`);
  const listed = (await (await call("/api/analysis-jobs", { headers: authed })).json()) as {
    jobs: unknown[];
  };
  expect(listed.jobs.length === 0, "the discarded job should not be listed");

  console.log("Docker smoke passed: app, AI worker (mock model) and mail worker cooperate.");
}

main().catch((error) => {
  console.error("Docker smoke FAILED:", error instanceof Error ? error.message : "unexpected error");
  process.exit(1);
});
