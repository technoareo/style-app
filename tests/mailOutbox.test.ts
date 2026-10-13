import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Build 008 durable account mail. A real SMTP conversation is held with a
 * small in-process fake relay (127.0.0.1, no network, no credentials); nodemailer
 * talks to it exactly as it would to a real server. Modes make it accept,
 * refuse temporarily (451), refuse permanently (550) or never answer.
 *
 * Request handlers only enqueue. The tests drive the worker's own
 * processNextMail() so every outcome is deterministic.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.MAIL_FROM = "Style Studio <no-reply@mail.example.test>";
process.env.STYLE_MAIL_SEND_TIMEOUT_MS = "1500";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;

// hang: accept TCP, never greet. trickle: greet one byte at a time, forever
// (steady "progress" that resets idle timers). slow: a normal conversation
// whose final acceptance (the 250 after DATA) is delayed past the send deadline.
type Mode = "ok" | "temp" | "perm" | "hang" | "trickle" | "slow";
type Received = { to: string[]; data: string };
const SLOW_ACK_MS = 3000;
const fake = {
  mode: "ok" as Mode,
  /** Modes consumed one per NEW connection before falling back to `mode`. */
  queue: [] as Mode[],
  connections: 0,
  /** Acceptances actually written to a still-open client connection. */
  acked: 0,
  received: [] as Received[],
};
const sockets = new Set<net.Socket>();
const smtp = net.createServer((socket) => {
  fake.connections++;
  const mode: Mode = fake.queue.length ? fake.queue.shift()! : fake.mode;
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  if (mode === "hang") return;
  if (mode === "trickle") {
    const greeting = "220 fake.test ESMTP trickling greeting that never completes";
    let i = 0;
    const tick = setInterval(() => {
      if (socket.destroyed || i >= greeting.length) return clearInterval(tick);
      socket.write(greeting[i++]);
    }, 100);
    socket.on("close", () => clearInterval(tick));
    return;
  }
  socket.write("220 fake.test ESMTP\r\n");
  let buffer = "";
  let inData = false;
  let current: Received = { to: [], data: "" };
  socket.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        current.data = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        fake.received.push(current);
        current = { to: [], data: "" };
        const accept = () => {
          // Only a client that is still connected hears the acceptance.
          if (socket.destroyed) return;
          fake.acked++;
          socket.write("250 2.0.0 queued\r\n");
        };
        if (mode === "slow") setTimeout(accept, SLOW_ACK_MS);
        else accept();
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol < 0) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      const command = line.slice(0, 4).toUpperCase();
      if (command === "EHLO" || command === "HELO")
        socket.write("250 fake.test\r\n");
      else if (command === "MAIL")
        socket.write(
          mode === "temp" ? "451 4.3.0 try again later\r\n" : "250 ok\r\n",
        );
      else if (command === "RCPT") {
        if (mode === "perm") socket.write("550 5.1.1 no such user\r\n");
        else {
          current.to.push(line.replace(/^RCPT TO:\s*<?([^>\s]*)>?.*$/i, "$1"));
          socket.write("250 ok\r\n");
        }
      } else if (command === "DATA") {
        inData = true;
        socket.write("354 go ahead\r\n");
      } else if (command === "QUIT") {
        socket.write("221 bye\r\n");
        socket.end();
      } else socket.write("250 ok\r\n");
    }
  });
});

type Outbox = typeof import("../src/server/mailOutbox");
type Mail = typeof import("../src/server/mail");
let m: Outbox;
let mail: Mail;
let db: import("node:sqlite").DatabaseSync;
let auth: Awaited<ReturnType<typeof import("../src/server/auth").getReadyAuth>>;
let n = 0;

const decode = (raw: string) =>
  raw
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
const tokenIn = (raw: string) =>
  /token=([A-Za-z0-9._-]+)/.exec(decode(raw))?.[1];
const row = (id: string) =>
  db.prepare("SELECT * FROM mail_outbox WHERE id=?").get(id) as
    | Record<string, unknown>
    | undefined;
const rowsFor = (userId: string) =>
  db
    .prepare("SELECT * FROM mail_outbox WHERE user_id=? ORDER BY created_at, rowid")
    .all(userId) as Record<string, unknown>[];
const env = [
  "STYLE_MAIL_MAX_ATTEMPTS",
  "STYLE_MAIL_PER_RECIPIENT_HOUR",
  "STYLE_MAIL_PER_RECIPIENT_DAY",
  "STYLE_MAIL_MAX_PENDING",
  "STYLE_MAIL_MAX_PER_HOUR",
  "STYLE_MAIL_WINDOW_MS",
];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(20);
  }
}
function reset() {
  fake.mode = "ok";
  fake.queue = [];
  fake.acked = 0;
  fake.received = [];
  db.exec("DELETE FROM mail_outbox");
  for (const name of env) delete process.env[name];
  process.env.SMTP_URL = `smtp://127.0.0.1:${(smtp.address() as net.AddressInfo).port}`;
}
async function newUser(label: string) {
  const email = `${label}-${n++}@example.test`;
  const created = await auth.api.signUpEmail({
    body: { email, name: label, password: "Mail test passphrase 77!" },
  });
  return { id: created.user.id, email };
}
const resetMessage = (email: string, marker: string) =>
  mail.passwordResetMessage(email, `https://example.test/reset/${marker}`);
const enqueue = (u: { id: string; email: string }, marker: string) =>
  m.enqueueMail({
    userId: u.id,
    kind: "reset-password",
    ...resetMessage(u.email, marker),
  });
function crash(mode: string, userId = "-", email = "-") {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "tests/helpers/mailCrashChild.ts", mode, userId, email],
      {
        cwd: process.cwd(),
        env: { ...process.env, STYLE_DATA_DIR: dataDir },
        windowsHide: true,
      },
    );
    child.on("error", reject);
    child.on("close", resolve);
  });
}

before(async () => {
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  process.env.SMTP_URL = `smtp://127.0.0.1:${(smtp.address() as net.AddressInfo).port}`;
  const { getReadyAuth } = await import("../src/server/auth");
  auth = await getReadyAuth();
  db = (await import("../src/server/database")).getDatabase();
  m = await import("../src/server/mailOutbox");
  mail = await import("../src/server/mail");
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  (await import("../src/server/database")).closeDatabases();
});

test("a sign-up request only enqueues: SMTP is never contacted by the request, and the delivered link verifies the account", async () => {
  reset();
  // If the request (or anything it spawned) tried SMTP it would connect here.
  fake.mode = "hang";
  const user = await newUser("signup");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(fake.connections, 0, "no SMTP connection from the request");
  const rows = rowsFor(user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "verify-email");
  assert.equal(rows[0].status, "queued");
  assert.equal(rows[0].to_address, user.email);
  assert.match(String(rows[0].id), /^[0-9a-f-]{36}$/, "stable message id");

  fake.mode = "ok";
  assert.equal(await m.processNextMail(), true);
  assert.equal(await m.processNextMail(), false, "nothing else is due");
  const sent = row(String(rows[0].id))!;
  assert.equal(sent.status, "sent");
  assert.equal(sent.attempts, 1);
  for (const column of ["to_address", "subject", "text_body", "html_body"])
    assert.equal(sent[column], null, `${column} cleared once delivered`);
  assert.equal(fake.received.length, 1);
  assert.deepEqual(fake.received[0].to, [user.email]);

  const token = tokenIn(fake.received[0].data);
  assert.ok(token, "the delivered message carries the verification link");
  await assert.rejects(
    auth.api.signInEmail({
      body: { email: user.email, password: "Mail test passphrase 77!" },
    }),
    "not verified yet",
  );
  await auth.api.verifyEmail({ query: { token } });
  const response = await auth.api.signInEmail({
    body: { email: user.email, password: "Mail test passphrase 77!" },
    asResponse: true,
  });
  assert.equal(response.status, 200, "token consumption is unchanged");
});

test("the mail row commits or rolls back with the surrounding Better Auth transaction", async () => {
  reset();
  const user = await newUser("atomic");
  db.exec("DELETE FROM mail_outbox");
  const { runWithTransaction } = await import("@better-auth/core/context");
  const context = await (
    auth as unknown as { $context: Promise<{ adapter: never }> }
  ).$context;

  // The callback runs inside the transaction; a failure after it undoes it.
  await assert.rejects(
    runWithTransaction(context.adapter, async () => {
      const result = await m.queueVerificationEmail(
        user,
        "https://example.test/verify?token=rolled-back",
      );
      assert.equal(result.status, "queued");
      assert.equal(
        rowsFor(user.id).length,
        0,
        "not visible to other connections before commit",
      );
      throw new Error("simulated failure after the mail callback");
    }),
  );
  assert.equal(rowsFor(user.id).length, 0, "rollback removed the mail row");

  await runWithTransaction(context.adapter, async () => {
    await m.queueVerificationEmail(
      user,
      "https://example.test/verify?token=committed",
    );
  });
  const committed = rowsFor(user.id);
  assert.equal(committed.length, 1, "commit kept exactly the one row");
  assert.equal(committed[0].status, "queued");
});

test("a process that dies mid-transaction leaves no mail; one that dies after COMMIT leaves exactly one", async () => {
  reset();
  const user = await newUser("crash");
  db.exec("DELETE FROM mail_outbox");
  assert.equal(await crash("abort", user.id, user.email), 9);
  assert.equal(rowsFor(user.id).length, 0, "uncommitted insert vanished with the process");
  assert.equal(await crash("commit", user.id, user.email), 9);
  assert.equal(rowsFor(user.id).length, 1, "committed insert survived the crash");
  // And the database still takes writes (the dead process left no lock behind).
  await enqueue(user, "after-crash");
  assert.equal(
    (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check,
    "ok",
  );
});

test("a worker that dies after claiming does not lose the message: it is delivered again after the lease, with the same Message-ID", async () => {
  reset();
  const user = await newUser("restart");
  db.exec("DELETE FROM mail_outbox");
  const queued = await enqueue(user, "restart-marker");
  assert.equal(queued.status, "queued");
  const id = (queued as { id: string }).id;

  assert.equal(await crash("claim"), 9, "worker died holding the claim");
  assert.equal(row(id)?.status, "sending");
  assert.equal(await m.processNextMail(), false, "lease still held: not re-sent early");
  assert.equal(fake.received.length, 0);

  // Lease lapses (the worker's restart is simulated by time passing).
  db.prepare("UPDATE mail_outbox SET lease_until=? WHERE id=?").run(Date.now() - 1, id);
  assert.equal(await m.processNextMail(), true);
  assert.equal(row(id)?.status, "sent");
  assert.equal(row(id)?.attempts, 2, "the dead worker's attempt counted");
  assert.equal(fake.received.length, 1);
  assert.match(decode(fake.received[0].data), /restart-marker/);

  // At-least-once: SMTP accepted the message but the outcome was never
  // recorded (crash between the two), so it is sent again. Not exactly-once.
  const second = await enqueue(user, "dup-marker");
  const secondId = (second as { id: string }).id;
  const claim = await (await import("../src/server/writeTransaction")).runWriteTransaction(
    (d) => m.claimNextMailLocked(d, Date.now()),
  );
  assert.ok(claim && claim.id === secondId);
  await mail.deliverMessage(claim.message, claim.id); // delivered...
  // ...and the worker dies before recording it.
  db.prepare("UPDATE mail_outbox SET lease_until=? WHERE id=?").run(Date.now() - 1, secondId);
  assert.equal(await m.processNextMail(), true);
  const copies = fake.received.filter((r) => /dup-marker/.test(decode(r.data)));
  assert.equal(copies.length, 2, "duplicate delivery is possible and expected");
  const ids = copies.map((c) => /Message-ID:\s*<([^>]+)>/i.exec(c.data)?.[1]);
  assert.equal(ids[0], ids[1], "both copies carry the same Message-ID");
  assert.match(String(ids[0]), new RegExp(`^${secondId}@`));
});

test("temporary failures back off and stop at the attempt bound; permanent refusals stop at once; nothing leaks into logs", async () => {
  reset();
  process.env.STYLE_MAIL_MAX_ATTEMPTS = "3";
  // Accounts are created before logging is captured, so only the outbox's own
  // output is examined below.
  const user = await newUser("retry");
  const other = await newUser("perm");
  db.exec("DELETE FROM mail_outbox");
  const logged: string[] = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    const queued = (await enqueue(user, "secret-reset-marker")) as { id: string };
    fake.mode = "temp";
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await m.processNextMail(), true);
      const r = row(queued.id)!;
      assert.equal(r.attempts, attempt);
      assert.equal(r.last_error_code, "smtp-4xx");
      if (attempt < 3) {
        assert.equal(r.status, "queued");
        assert.ok(Number(r.next_attempt_at) > Date.now(), "backs off");
        assert.equal(await m.processNextMail(), false, "not retried before it is due");
        db.prepare("UPDATE mail_outbox SET next_attempt_at=0 WHERE id=?").run(queued.id);
      }
    }
    const failed = row(queued.id)!;
    assert.equal(failed.status, "failed", "bounded attempts");
    for (const column of ["to_address", "subject", "text_body", "html_body"])
      assert.equal(failed[column], null);
    assert.equal(fake.received.length, 0);

    // Permanent refusal: one attempt.
    fake.mode = "perm";
    const permanent = (await enqueue(other, "perm-marker")) as { id: string };
    assert.equal(await m.processNextMail(), true);
    assert.equal(row(permanent.id)?.status, "failed");
    assert.equal(row(permanent.id)?.attempts, 1);
    assert.equal(row(permanent.id)?.last_error_code, "smtp-5xx");

    // Relay down: a connection error is retried, not lost.
    fake.mode = "ok";
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    const down = (await enqueue(user, "down-marker")) as { id: string };
    assert.equal(await m.processNextMail(), true);
    assert.equal(row(down.id)?.status, "queued");
    assert.match(String(row(down.id)?.last_error_code), /^conn/);
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
  const everything = logged.join("\n");
  assert.ok(logged.length > 0, "failures are logged");
  assert.doesNotMatch(everything, /@example\.test/, "no addresses in logs");
  assert.doesNotMatch(everything, /marker|token=|https?:\/\//i, "no links or bodies in logs");
});

test("a relay that never answers cannot hold the worker past the send bound", async () => {
  reset();
  const user = await newUser("hang");
  db.exec("DELETE FROM mail_outbox");
  const queued = (await enqueue(user, "hang-marker")) as { id: string };
  fake.mode = "hang";
  const started = Date.now();
  assert.equal(await m.processNextMail(), true);
  assert.ok(Date.now() - started < 4000, "bounded by STYLE_MAIL_SEND_TIMEOUT_MS");
  assert.equal(row(queued.id)?.status, "queued");
  assert.equal(row(queued.id)?.last_error_code, "timeout");
  // The deadline closed the connection itself; it was not merely abandoned.
  await until(() => sockets.size === 0, 2000, "the relay to see the connection close");
});

test("a send is cancelled at the deadline by closing its own connection: a late acceptance never reaches the worker and no connection survives into the next attempt", async () => {
  reset();
  const user = await newUser("slow");
  db.exec("DELETE FROM mail_outbox");
  const queued = (await enqueue(user, "slow-marker")) as { id: string };
  fake.mode = "slow"; // handshake and DATA complete; the final 250 comes 3 s later
  const started = Date.now();
  assert.equal(await m.processNextMail(), true);
  assert.ok(
    Date.now() - started < SLOW_ACK_MS,
    "returned at the 1.5 s deadline, not when the relay finally answered",
  );
  assert.equal(row(queued.id)?.status, "queued");
  assert.equal(row(queued.id)?.last_error_code, "timeout");
  await until(() => sockets.size === 0, 2000, "the relay to see the connection close");

  // Wait out the relay's delayed acceptance: it must find nobody to tell.
  await sleep(SLOW_ACK_MS + 500);
  assert.equal(fake.acked, 0, "no acceptance reached a live client connection");
  assert.equal(sockets.size, 0, "no connection is left open");
  assert.equal(
    row(queued.id)?.status,
    "queued",
    "the late acceptance did not complete the abandoned attempt",
  );

  // The next attempt starts on a clean slate.
  fake.mode = "ok";
  db.prepare("UPDATE mail_outbox SET next_attempt_at=0 WHERE id=?").run(queued.id);
  assert.equal(await m.processNextMail(), true);
  assert.equal(row(queued.id)?.status, "sent");
  assert.equal(row(queued.id)?.attempts, 2);
  assert.equal(fake.acked, 1);
  // At-least-once caveat, shown honestly: the relay had already received the
  // first attempt's bytes, so it holds two copies with the same Message-ID.
  assert.equal(fake.received.length, 2);
  const ids = fake.received.map((r) => /Message-ID:\s*<([^>]+)>/i.exec(r.data)?.[1]);
  assert.equal(ids[0], ids[1]);
});

test("a relay that trickles its greeting forever cannot keep an attempt alive past the deadline, and leaves nothing open", async () => {
  reset();
  const user = await newUser("trickle");
  db.exec("DELETE FROM mail_outbox");
  const queued = (await enqueue(user, "trickle-marker")) as { id: string };
  fake.mode = "trickle";
  const started = Date.now();
  assert.equal(await m.processNextMail(), true);
  assert.ok(Date.now() - started < 4000, "ended at the deadline despite steady progress");
  assert.equal(row(queued.id)?.status, "queued");
  assert.equal(row(queued.id)?.last_error_code, "timeout");
  await until(() => sockets.size === 0, 2000, "the relay to see the connection close");
  const connections = fake.connections;
  await sleep(600);
  assert.equal(fake.connections, connections, "nothing reconnects behind the worker's back");
  assert.equal(sockets.size, 0);
});

test("cancelling one send closes only that send's connection: a concurrent legitimate send completes", async () => {
  reset();
  const a = await newUser("iso-a");
  const b = await newUser("iso-b");
  db.exec("DELETE FROM mail_outbox");
  const first = (await enqueue(a, "iso-a-marker")) as { id: string };
  const second = (await enqueue(b, "iso-b-marker")) as { id: string };
  fake.queue = ["trickle", "ok"]; // the first connection stalls, the second is healthy
  const results = await Promise.all([m.processNextMail(), m.processNextMail()]);
  assert.deepEqual(results, [true, true]);
  const statuses = [row(first.id)?.status, row(second.id)?.status].sort();
  assert.deepEqual(statuses, ["queued", "sent"], "one timed out, the other was delivered");
  const stalled = [first.id, second.id].find((id) => row(id)?.status === "queued")!;
  assert.equal(row(stalled)?.last_error_code, "timeout");
  assert.equal(fake.received.length, 1, "exactly the healthy message arrived");
  await until(() => sockets.size === 0, 2000, "every connection to close");
});

test("messages expire with their link: bodies are cleared and nothing stale is sent", async () => {
  reset();
  const user = await newUser("expire");
  db.exec("DELETE FROM mail_outbox");
  const queued = (await enqueue(user, "expire-marker")) as { id: string };
  assert.ok(
    Number(row(queued.id)?.expires_at) - Number(row(queued.id)?.created_at) <=
      45 * 60_000,
    "delivery window leaves the link time to be used",
  );
  db.prepare("UPDATE mail_outbox SET expires_at=? WHERE id=?").run(Date.now() - 1, queued.id);
  assert.equal(await m.processNextMail(), false);
  const expired = row(queued.id)!;
  assert.equal(expired.status, "expired");
  for (const column of ["to_address", "subject", "text_body", "html_body"])
    assert.equal(expired[column], null);
  assert.equal(fake.received.length, 0);
});

test("recipient, global and per-hour bounds drop excess mail silently; a newer link replaces an unsent older one", async () => {
  reset();
  const a = await newUser("bound-a");
  const b = await newUser("bound-b");
  db.exec("DELETE FROM mail_outbox");

  process.env.STYLE_MAIL_PER_RECIPIENT_HOUR = "2";
  const first = (await enqueue(a, "one")) as { id: string };
  const second = (await enqueue(a, "two")) as { id: string };
  const third = await enqueue(a, "three");
  assert.deepEqual(third, { status: "dropped", reason: "recipient-limit" });
  assert.equal(row(first.id)?.status, "cancelled", "superseded by the newer link");
  assert.equal(row(first.id)?.text_body, null);
  assert.equal(row(second.id)?.status, "queued");
  assert.equal((await enqueue(b, "other-recipient")).status, "queued", "limits are per recipient");

  // Sent mail still counts toward the recipient's hour.
  assert.equal(await m.processNextMail(), true);
  assert.deepEqual(await enqueue(a, "four"), { status: "dropped", reason: "recipient-limit" });

  reset();
  const c = await newUser("bound-c");
  const d = await newUser("bound-d");
  const e = await newUser("bound-e");
  db.exec("DELETE FROM mail_outbox");
  process.env.STYLE_MAIL_MAX_PENDING = "2";
  assert.equal((await enqueue(c, "c")).status, "queued");
  assert.equal((await enqueue(d, "d")).status, "queued");
  assert.deepEqual(await enqueue(e, "e"), { status: "dropped", reason: "queue-full" });

  reset();
  const f = await newUser("bound-f");
  db.exec("DELETE FROM mail_outbox");
  process.env.STYLE_MAIL_MAX_PER_HOUR = "1";
  assert.equal((await enqueue(f, "f1")).status, "queued");
  assert.deepEqual(await enqueue(await newUser("bound-g"), "g"), {
    status: "dropped",
    reason: "queue-full",
  });

  reset();
  process.env.STYLE_MAIL_PER_RECIPIENT_DAY = "1";
  const h = await newUser("bound-h");
  db.exec("DELETE FROM mail_outbox");
  assert.equal((await enqueue(h, "h1")).status, "queued");
  assert.deepEqual(
    await m.enqueueMail({
      userId: h.id,
      kind: "verify-email",
      ...mail.verificationMessage(h.email, "https://example.test/v?token=x"),
    }),
    { status: "dropped", reason: "recipient-limit" },
    "the daily bound covers all kinds",
  );
});

test("deleting an account deletes its queued mail, and a message in flight records nothing", async () => {
  reset();
  const gone = await newUser("delete-me");
  const kept = await newUser("keep-me");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(gone, "gone-marker");
  const keptMail = (await enqueue(kept, "kept-marker")) as { id: string };
  db.prepare("DELETE FROM user WHERE id=?").run(gone.id);
  assert.equal(rowsFor(gone.id).length, 0, "cascade removed address and body");
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE text_body LIKE '%gone-marker%'")
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(row(keptMail.id)?.status, "queued");

  // Deleted while a worker holds the claim: the outcome is simply not recorded.
  const { runWriteTransaction } = await import("../src/server/writeTransaction");
  const claim = await runWriteTransaction((d) => m.claimNextMailLocked(d, Date.now()));
  assert.ok(claim);
  db.prepare("DELETE FROM user WHERE id=?").run(kept.id);
  const recorded = await runWriteTransaction((d) =>
    m.finishMailLocked(d, claim.id, claim.lease, { kind: "sent" }, Date.now()),
  );
  assert.equal(recorded, false);
  assert.equal(row(claim.id), undefined);
});

test("each recipient's message carries only that recipient's link", async () => {
  reset();
  const alice = await newUser("tenant-a");
  const bob = await newUser("tenant-b");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(alice, "ALICE-LINK-111");
  await enqueue(bob, "BOB-LINK-222");
  while (await m.processNextMail()) {
    // drain
  }
  assert.equal(fake.received.length, 2);
  for (const r of fake.received) {
    assert.equal(r.to.length, 1);
    const body = decode(r.data);
    if (r.to[0] === alice.email) {
      assert.match(body, /ALICE-LINK-111/);
      assert.doesNotMatch(body, /BOB-LINK-222|tenant-b-/);
    } else {
      assert.equal(r.to[0], bob.email);
      assert.match(body, /BOB-LINK-222/);
      assert.doesNotMatch(body, /ALICE-LINK-111|tenant-a-/);
    }
  }
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE text_body IS NOT NULL OR to_address IS NOT NULL")
        .get() as { n: number }
    ).n,
    0,
    "nothing readable remains once delivered",
  );
});

test("request paths and public health stay clear of SMTP and queue details", async () => {
  const outbox = readFileSync("src/server/mailOutbox.ts", "utf8");
  assert.doesNotMatch(outbox, /analysisJobs|\.\/vision/, "mail never depends on the AI queue");
  const authSource = readFileSync("src/server/auth.ts", "utf8");
  assert.doesNotMatch(authSource, /backgroundTasks:\s*\{/, "no detached sender");
  assert.doesNotMatch(authSource, /sendMail|nodemailer/);
  const { GET } = await import("../src/app/api/health/route");
  assert.deepEqual(await (await GET()).json(), { ready: true });

  // Local capture is a development-only fallback, never a public one.
  const previousUrl = process.env.SMTP_URL;
  try {
    delete process.env.SMTP_URL;
    assert.equal(mail.usesLocalCapture(), true, "development without SMTP captures");
    process.env.STYLE_PUBLIC_DEPLOYMENT = "true";
    assert.equal(mail.usesLocalCapture(), false, "public mode never captures");
    await assert.rejects(
      mail.deliverMessage(resetMessage("x@example.test", "nope")),
      /not configured/,
      "public mode without SMTP refuses instead of writing a file",
    );
  } finally {
    delete process.env.STYLE_PUBLIC_DEPLOYMENT;
    process.env.SMTP_URL = previousUrl;
  }
});
