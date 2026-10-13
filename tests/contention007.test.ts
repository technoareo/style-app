import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { waitForMail } from "./helpers/mailCapture";

/**
 * When the write lock cannot be taken for an auth transaction, the public auth
 * route answers a retryable 503 with Retry-After. The transaction never
 * began, so nothing is written and a one-time token is not consumed, and the
 * identical request succeeds once the lock clears (no replay inside the
 * failed attempt).
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.STYLE_AUTH_LOCK_MS = "300";
mkdirSync(dataDir, { recursive: true });

let holder: DatabaseSync | undefined;
after(async () => {
  if (holder?.isOpen) {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
  }
  (await import("../src/server/database")).closeDatabases();
});

test("a refused write lock becomes a truthful retryable 503 with no side effects and no token consumed", async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const route = await import("../src/app/api/auth/[...all]/route");
  const auth = await getReadyAuth();
  const db = getDatabase();
  const origin = process.env.APP_URL!;
  holder = new DatabaseSync(path.join(dataDir, "app.db"), { timeout: 1 });
  const post = (route_: string, body: unknown) =>
    route.POST(
      new NextRequest(origin + route_, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const users = (email: string) =>
    (
      db.prepare("SELECT COUNT(*) AS n FROM user WHERE email=?").get(email) as {
        n: number;
      }
    ).n;

  // --- sign-up while another process holds the write lock ---
  const signUp = {
    email: "busy-a@example.test",
    name: "Busy A",
    password: "Busy passphrase 123!",
  };
  holder.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  const refused = await post("/api/auth/sign-up/email", signUp);
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("retry-after"), "5");
  const body = await refused.json();
  assert.equal(body.code, "busy");
  assert.ok(Date.now() - started < 5000, "bounded wait");
  holder.exec("ROLLBACK");
  assert.equal(users(signUp.email), 0, "no side effects from the refused attempt");

  // The identical input succeeds once the lock is free; exactly one user.
  const retried = await post("/api/auth/sign-up/email", signUp);
  assert.equal(retried.status, 200);
  assert.equal(users(signUp.email), 1);

  // --- one-time verification token is not consumed by a refused attempt ---
  // The sign-up only enqueued; the local capture appears a moment later.
  const mail = await waitForMail(dataDir, signUp.email, "Verify");
  const token = new URL(mail.text.split(": ").slice(1).join(": ")).searchParams.get(
    "token",
  )!;
  const verify = () =>
    route.GET(
      new NextRequest(
        `${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
        { method: "GET", headers: { origin } },
      ),
    );
  const verified = () =>
    (
      db.prepare("SELECT emailVerified AS v FROM user WHERE email=?").get(
        signUp.email,
      ) as { v: number }
    ).v;
  holder.exec("BEGIN IMMEDIATE");
  const verifyRefused = await verify();
  assert.equal(verifyRefused.status, 503);
  assert.equal(verifyRefused.headers.get("retry-after"), "5");
  holder.exec("ROLLBACK");
  assert.equal(verified(), 0, "not verified by the refused attempt");
  const verifyOk = await verify();
  assert.ok(verifyOk.status < 400, `token still usable, got ${verifyOk.status}`);
  assert.equal(verified(), 1, "the same token worked afterwards");
  void auth;
});
