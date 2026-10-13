import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * Build 009, C1: mail-worker health and shutdown.
 *
 * Unit tests drive the heartbeat controller with a fake clock and
 * processNextMail() in-process. The process tests start the REAL
 * scripts/mail-worker.ts as a child (fork, so an IPC channel exists: Windows
 * cannot deliver SIGTERM to a child, and the worker treats the IPC message
 * "shutdown" exactly like SIGTERM) against a fake SMTP relay.
 *
 * Times are shortened through the STYLE_MAIL_* variables so the sustained-load
 * test needs seconds, not minutes; the production defaults are asserted in the
 * limits test, and the relation between the shortened and default values is the
 * same (freshness window = several beats, a beat much shorter than one send).
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.MAIL_FROM = "Style Studio <no-reply@mail.example.test>";
delete process.env.STYLE_PUBLIC_DEPLOYMENT;

type Mode = "ok" | "hang";
const relay = {
  mode: "ok" as Mode,
  connections: 0,
  closed: 0,
  received: 0,
};
const sockets = new Set<net.Socket>();
const smtp = net.createServer((socket) => {
  relay.connections++;
  sockets.add(socket);
  socket.on("close", () => {
    sockets.delete(socket);
    relay.closed++;
  });
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  if (relay.mode === "hang") return;
  socket.write("220 fake.test ESMTP\r\n");
  let buffer = "";
  let inData = false;
  socket.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        buffer = buffer.slice(end + 5);
        inData = false;
        relay.received++;
        socket.write("250 2.0.0 queued\r\n");
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol < 0) return;
      const command = buffer.slice(0, 4).toUpperCase();
      buffer = buffer.slice(eol + 2);
      if (command === "DATA") {
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
let smtpUrl = "";
let n = 0;
const children = new Set<ChildProcess>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LIMIT_ENV = [
  "STYLE_MAIL_SEND_TIMEOUT_MS",
  "STYLE_MAIL_HEARTBEAT_MS",
  "STYLE_MAIL_HEALTH_FRESH_MS",
  "STYLE_MAIL_RECORD_RETRIES",
  "STYLE_MAIL_RECORD_ACQUIRE_MS",
  "STYLE_MAIL_SHUTDOWN_RECORD_RETRIES",
  "STYLE_MAIL_SHUTDOWN_RECORD_ACQUIRE_MS",
  "STYLE_MAIL_SHUTDOWN_EXIT_MS",
  "STYLE_MAIL_MAX_ATTEMPTS",
  "STYLE_MAIL_BACKOFF_MS",
  "STYLE_MAIL_BACKOFF_CAP_MS",
];
function reset() {
  relay.mode = "ok";
  relay.connections = 0;
  relay.closed = 0;
  relay.received = 0;
  for (const name of LIMIT_ENV) delete process.env[name];
  process.env.SMTP_URL = smtpUrl;
  db.exec("DELETE FROM mail_outbox");
}
async function newUser(label: string) {
  const email = `${label}-${n++}@example.test`;
  const created = await auth.api.signUpEmail({
    body: { email, name: label, password: "Mail worker passphrase 91!" },
  });
  return { id: created.user.id, email };
}
const enqueue = (u: { id: string; email: string }, marker: string) =>
  m.enqueueMail({
    userId: u.id,
    kind: "reset-password",
    ...mail.passwordResetMessage(u.email, `https://example.test/reset/${marker}`),
  });
const rowsByStatus = () =>
  db.prepare("SELECT * FROM mail_outbox ORDER BY created_at, rowid").all() as Record<
    string,
    unknown
  >[];

type Worker = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
};
function startWorker(env: Record<string, string>, preload: string[] = []): Worker {
  const child = fork(path.join(process.cwd(), "scripts", "mail-worker.ts"), [], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx", ...preload.flatMap((p) => ["--import", p])],
    env: { ...process.env, STYLE_DATA_DIR: dataDir, SMTP_URL: smtpUrl, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}
async function until(check: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(25);
  }
}
const heartbeatAge = () => m.mailHeartbeatAgeMs();
/** The raw time of the worker's last beat (null if it never wrote one). */
const heartbeatAt = () =>
  (
    db.prepare("SELECT heartbeat_at FROM mail_worker_state WHERE id=1").get() as
      | { heartbeat_at: number }
      | undefined
  )?.heartbeat_at ?? null;
/**
 * Startup acknowledgement of a freshly started real worker: it has printed its
 * "started" line AND written a heartbeat NEWER than `before` (an earlier test's
 * worker leaves its last beat in the table, so a bare "a beat exists" or "the
 * age is small" would prove nothing). The wait is for cold tsx start-up plus
 * schema readiness, which a loaded host can stretch to a minute; it is a bound
 * on start-up, not a timing assumption about behaviour.
 */
async function workerReady(worker: Worker, before: number | null) {
  await until(() => /Mail worker started\./.test(worker.stdout()), 120_000, "the worker to report started");
  await until(
    () => {
      const at = heartbeatAt();
      return at !== null && (before === null || at > before);
    },
    30_000,
    "the worker's first heartbeat",
  );
}
function check(env: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "scripts/mail-worker.ts", "--check"],
      { cwd: process.cwd(), env: { ...process.env, STYLE_DATA_DIR: dataDir, ...env }, windowsHide: true },
      (error) => {
        if (!error) return resolve(0);
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") return resolve(code);
        reject(error);
      },
    );
  });
}

before(async () => {
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  smtpUrl = `smtp://127.0.0.1:${(smtp.address() as net.AddressInfo).port}`;
  process.env.SMTP_URL = smtpUrl;
  const { getReadyAuth } = await import("../src/server/auth");
  auth = await getReadyAuth();
  db = (await import("../src/server/database")).getDatabase();
  m = await import("../src/server/mailOutbox");
  mail = await import("../src/server/mail");
});

after(async () => {
  for (const child of children) child.kill();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
  (await import("../src/server/database")).closeDatabases();
});

/* ------------------------------------------------------------------ */
/* Bounds and configuration                                           */
/* ------------------------------------------------------------------ */

test("production defaults: the shutdown work is bounded below the exit bound, which is below the compose grace period", async () => {
  reset();
  const { mailLimits } = await import("../src/server/limits");
  const l = mailLimits();
  assert.equal(l.heartbeatMs, 10_000);
  assert.equal(l.healthFreshMs, 60_000);
  assert.equal(l.recordRetries, 8, "the 008 record bound is unchanged");
  assert.equal(l.recordAcquireMs, 5_000);
  assert.equal(l.shutdownExitMs, 25_000);
  assert.equal(l.sendTimeoutMs, 45_000);
  const worst = m.mailShutdownWorstCaseMs();
  assert.equal(worst, 16_500, "claim 10 s + three 2 s tries + two 250 ms pauses");
  assert.ok(worst < l.shutdownExitMs, "legitimate shutdown work fits before the hard exit");

  const compose = readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");
  const start = compose.indexOf("\n  mailer:");
  const block = compose.slice(start, compose.indexOf("\n  ollama:", start));
  const grace = /stop_grace_period:\s*(\d+)s/.exec(block);
  assert.ok(grace, "the mailer service sets stop_grace_period");
  assert.ok(
    Number(grace[1]) * 1000 > l.shutdownExitMs,
    "Docker waits longer than the worker's own hard exit",
  );
  assert.match(block, /command:\s*\["node", "--import", "tsx"/, "node is PID 1");
});

test("out-of-range health settings fall back; the freshness window is never under three beats", async () => {
  reset();
  const { mailLimits } = await import("../src/server/limits");
  process.env.STYLE_MAIL_HEARTBEAT_MS = "5000";
  process.env.STYLE_MAIL_HEALTH_FRESH_MS = "6000";
  assert.equal(mailLimits().healthFreshMs, 15_000);
  process.env.STYLE_MAIL_HEARTBEAT_MS = "1";
  process.env.STYLE_MAIL_HEALTH_FRESH_MS = "garbage";
  assert.equal(mailLimits().heartbeatMs, 10_000);
  assert.equal(mailLimits().healthFreshMs, 60_000);
  reset();
});

/* ------------------------------------------------------------------ */
/* Heartbeat controller (fake clock)                                  */
/* ------------------------------------------------------------------ */

test("the heartbeat reports while the loop makes progress, stops when it is stuck, never overlaps, and survives a failed write", async () => {
  const { createMailHeartbeat } = await import("../src/server/mailHealth");
  let clock = 1_000;
  let writes = 0;
  let errors = 0;
  // Holders are objects: TypeScript would narrow plain `let`s assigned in the
  // callbacks below.
  const gate: { release: (() => void) | null } = { release: null };
  const flags = { failNext: false };
  const hb = createMailHeartbeat({
    intervalMs: 10,
    stuckAfterMs: 5_000,
    now: () => clock,
    onError: () => errors++,
    touch: async () => {
      if (flags.failNext) {
        flags.failNext = false;
        throw new Error("write refused");
      }
      writes++;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    },
  });
  // First tick starts a write that stays in flight.
  const first = hb.tick();
  assert.equal(await hb.tick(), "skipped-busy");
  gate.release!();
  assert.equal(await first, "written");
  assert.equal(writes, 1, "overlapping ticks did not start a second write");

  // Progress at t=1000; the loop then goes silent.
  hb.progress();
  clock += 4_000;
  const ok = hb.tick();
  gate.release!();
  assert.equal(await ok, "written", "within one bounded step: still reporting");
  clock += 2_000; // 6 s since progress > 5 s bound
  assert.equal(await hb.tick(), "skipped-stuck", "a wedged loop stops reporting");
  assert.equal(writes, 2);
  hb.progress();
  flags.failNext = true;
  assert.equal(await hb.tick(), "failed");
  assert.equal(errors, 1);
  const again = hb.tick();
  gate.release!();
  assert.equal(await again, "written", "a failed write is simply retried");
});

/* ------------------------------------------------------------------ */
/* processNextMail with a shutdown signal (in-process)                */
/* ------------------------------------------------------------------ */

test("shutdown during a send cancels it, gives the attempt back and queues the message again", async () => {
  reset();
  const user = await newUser("cancel");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(user, "cancel-1");
  const control = new AbortController();
  let progress = 0;
  let sawAbort = false;
  // Proves the send was really in flight before the shutdown was requested;
  // under load the claim can take longer than any fixed pause.
  let sendStarted!: () => void;
  const started$ = new Promise<void>((r) => (sendStarted = r));
  const run = m.processNextMail({
    shutdown: control.signal,
    onProgress: () => progress++,
    send: (_message, _id, signal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(Object.assign(new Error("closed"), { code: "EMAIL_SEND_TIMEOUT" }));
          },
          { once: true },
        );
        sendStarted();
      }),
  });
  await started$;
  const started = Date.now();
  control.abort();
  assert.equal(await run, true);
  assert.ok(Date.now() - started < 2_000, "returns promptly, not at the 45 s deadline");
  assert.ok(sawAbort, "the send was cancelled through its signal");
  assert.ok(progress >= 4, "every bounded step reported progress");
  const [row] = rowsByStatus();
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0, "a cancelled send is not a failed attempt");
  assert.equal(row.last_error_code, "shutdown");
  assert.equal(row.lease_until, null);
  assert.equal(row.to_address, user.email, "the message is still deliverable");

  // Nothing is claimed once shutdown has begun.
  assert.equal(await m.processNextMail({ shutdown: control.signal }), false);
  assert.equal(rowsByStatus()[0].status, "queued");

  // After a restart the message goes out once.
  assert.equal(await m.processNextMail(), true);
  assert.equal(rowsByStatus()[0].status, "sent");
  assert.equal(relay.received, 1);
});

test("a send that finished before the cancel took effect is recorded as sent, not released", async () => {
  reset();
  const user = await newUser("raced");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(user, "raced-1");
  const control = new AbortController();
  // The ordering is explicit and asserted, not assumed from a pause: the send
  // starts, shutdown is requested, the send SEES the cancellation and still
  // completes successfully. Production must then record `sent` (the relay has
  // the message), not release it. (If the claim had not yet reached the send
  // when shutdown was requested, production correctly releases the unstarted
  // claim instead; the latch rules that case out here.)
  const order: string[] = [];
  let sendStarted!: () => void;
  const started$ = new Promise<void>((r) => (sendStarted = r));
  const run = m.processNextMail({
    shutdown: control.signal,
    send: (_message, _id, signal) =>
      new Promise<void>((resolve) => {
        order.push("send-started");
        signal.addEventListener(
          "abort",
          () => {
            order.push("send-saw-cancel");
            order.push("send-succeeded");
            resolve();
          },
          { once: true },
        );
        sendStarted();
      }),
  });
  await started$;
  order.push("shutdown-requested");
  control.abort();
  assert.equal(await run, true);
  assert.deepEqual(order, [
    "send-started",
    "shutdown-requested",
    "send-saw-cancel",
    "send-succeeded",
  ]);
  assert.equal(rowsByStatus()[0].status, "sent");
});

test("shutdown requested before the send starts releases the unstarted claim without calling the sender", async () => {
  reset();
  const user = await newUser("unstarted");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(user, "unstarted-1");
  const control = new AbortController();
  let sendCalls = 0;
  // Shutdown arrives during the claim (the first progress report after it).
  let reports = 0;
  const run = m.processNextMail({
    shutdown: control.signal,
    onProgress: () => {
      if (++reports === 2) control.abort(); // after the claim, before the send
    },
    send: async () => {
      sendCalls++;
    },
  });
  assert.equal(await run, true);
  assert.equal(sendCalls, 0, "an unstarted claim is never handed to SMTP");
  const [row] = rowsByStatus();
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error_code, "shutdown");
  assert.equal(relay.connections, 0);
});

test("shutdown while the outcome cannot be recorded stops quickly and leaves the row to lease recovery", async () => {
  reset();
  process.env.STYLE_MAIL_RECORD_ACQUIRE_MS = "300";
  process.env.STYLE_MAIL_SHUTDOWN_RECORD_ACQUIRE_MS = "200";
  process.env.STYLE_MAIL_SHUTDOWN_RECORD_RETRIES = "1";
  const user = await newUser("contended");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(user, "contended-1");
  // A second connection holds SQLite's write lock for the whole record phase.
  const other = new DatabaseSync(path.join(dataDir, "app.db"));
  const control = new AbortController();
  try {
    let reports = 0;
    const run = m.processNextMail({
      shutdown: control.signal,
      onProgress: () => reports++,
      send: async () => {
        other.exec("BEGIN IMMEDIATE");
      },
    });
    // Three reports (start, after the claim, after the send) mean the send has
    // finished and the record phase has begun; no pause is guessed.
    await until(() => reports >= 3, 10_000, "the send to finish");
    const started = Date.now();
    control.abort();
    assert.equal(await run, true);
    const elapsed = Date.now() - started;
    // In-flight try (<=300) + pause + (1+1) shutdown tries of 200 ms + pauses.
    assert.ok(elapsed < 2_000, `gave up within the shutdown budget (${elapsed} ms)`);
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
  const [row] = rowsByStatus();
  assert.equal(row.status, "sending", "no outcome was recorded");
  assert.ok(row.lease_until, "the lease is what returns it to the queue");
  // Lease recovery: once the lease has lapsed another claim delivers it.
  assert.equal(typeof row.id, "string");
  db.prepare("UPDATE mail_outbox SET lease_until=? WHERE id=?").run(
    Date.now() - 1,
    String(row.id),
  );
  assert.equal(await m.processNextMail(), true);
  assert.equal(rowsByStatus()[0].status, "sent");
  reset();
});

/* ------------------------------------------------------------------ */
/* The real worker loop (child process)                               */
/* ------------------------------------------------------------------ */

test("the real worker stays healthy through sustained slow deliveries, where the 008 loop went stale", async () => {
  reset();
  relay.mode = "hang";
  const users: { id: string; email: string }[] = [];
  for (const label of ["slow-a", "slow-b", "slow-c"]) users.push(await newUser(label));
  db.exec("DELETE FROM mail_outbox");
  for (const [i, u] of users.entries()) await enqueue(u, `slow-${i}`);
  assert.equal(rowsByStatus().length, 3);

  // Scaled windows and why. Production: a beat every 10 s, healthy while the
  // last beat is under 60 s old, i.e. six beats per window. Here: a beat every
  // 500 ms and a 5 s window, ten beats per window, so a host that stalls the
  // worker's timers for up to 4.5 s still passes while a loop that stops beating
  // fails. The workload is sized from that window, not from a guess: 3 messages
  // x 6 attempts x 800 ms against a relay that never answers is 14.4 s of
  // continuous work, almost three windows. The 008 loop touched its heartbeat
  // once before all of it and would be stale after 5 s.
  const SEND_MS = 800;
  const ATTEMPTS = 6;
  const FRESH_MS = 5_000;
  const env = {
    STYLE_MAIL_SEND_TIMEOUT_MS: String(SEND_MS),
    STYLE_MAIL_MAX_ATTEMPTS: String(ATTEMPTS),
    STYLE_MAIL_BACKOFF_MS: "10",
    STYLE_MAIL_BACKOFF_CAP_MS: "10",
    STYLE_MAIL_HEARTBEAT_MS: "500",
    STYLE_MAIL_HEALTH_FRESH_MS: String(FRESH_MS),
  };
  const baseline = heartbeatAt();
  const worker = startWorker(env);
  try {
    // Ordered start-up acknowledgement: "started" printed and a beat newer
    // than anything an earlier test left behind.
    await workerReady(worker, baseline);
    const began = Date.now();
    let samples = 0;
    let worst = 0;
    while (rowsByStatus().some((r) => r.status !== "failed")) {
      const age = heartbeatAge();
      assert.notEqual(age, null);
      worst = Math.max(worst, age!);
      assert.ok(age! < FRESH_MS, `heartbeat went stale while work progressed (${age} ms)`);
      samples++;
      if (Date.now() - began > 120_000) throw new Error("work did not finish");
      await sleep(100);
    }
    const duration = Date.now() - began;
    // The work really did outlast the window several times over (it began a
    // little before `began`, so this is a lower bound).
    assert.ok(duration >= 2 * FRESH_MS, `the load was sustained (${duration} ms)`);
    assert.ok(samples >= 50, `sampled throughout (${samples})`);
    // Exactly the controlled workload reached the relay: every attempt of every message.
    assert.equal(relay.connections, 3 * ATTEMPTS, "all attempts reached the relay");
    assert.ok(worst < FRESH_MS);
    assert.equal(
      await check(env),
      0,
      "the container health check agrees",
    );
  } finally {
    worker.child.send("shutdown");
    await worker.exited;
  }
  assert.match(worker.stdout(), /Mail worker started\./);
  assert.match(worker.stdout(), /Mail worker stopped\./);
});

test("a truly frozen worker stops reporting and the health check fails; it recovers when the freeze ends", async () => {
  reset();
  relay.mode = "hang";
  // Same scaling as the sustained test: ten beats per window (500 ms / 5 s).
  const FRESH_MS = 5_000;
  // The freeze is held by the PARENT: the worker stays blocked until the
  // parent creates a release file, which it does only after the real
  // `--check` process has read the heartbeat and returned. No duration is
  // guessed. The files live in a directory this test creates, with names the
  // preload validates, and the worker's own safety cap bounds a test that dies.
  const tag = randomBytes(4).toString("hex");
  const freezeDir = path.join(dataDir, `freeze-${tag}`);
  mkdirSync(freezeDir);
  const realFreezeDir = realpathSync(freezeDir);
  const ack = path.join(realFreezeDir, `freeze-ack-${tag}`);
  const release = path.join(realFreezeDir, `freeze-release-${tag}`);
  const env = {
    STYLE_MAIL_HEARTBEAT_MS: "500",
    STYLE_MAIL_HEALTH_FRESH_MS: String(FRESH_MS),
    TEST_FREEZE_DIR: realFreezeDir,
  };
  const preload = pathToFileURL(
    path.join(process.cwd(), "tests", "helpers", "mailWorkerFreeze.ts"),
  ).href;
  const baseline = heartbeatAt();
  const worker = startWorker(env, [preload]);
  try {
    await workerReady(worker, baseline);
    assert.ok((heartbeatAge() ?? Infinity) < FRESH_MS, "healthy before the freeze");

    // Ordered: the worker acknowledges (ack file) that it is about to block its
    // event loop, and blocks until the release file exists.
    worker.child.send({ freeze: { ack, release, capMs: 180_000 } });
    await until(() => existsSync(ack), 30_000, "the worker to acknowledge the freeze");
    // Frozen: no timer can fire, so the age must grow past the window. Wait for
    // the age itself (it can only keep growing from here), then run the REAL
    // cold `--check` while the worker is still frozen.
    await until(() => (heartbeatAge() ?? 0) >= FRESH_MS, 60_000, "the heartbeat to go stale");
    const midFreeze = await check(env);
    assert.equal(midFreeze, 1, "the health check reports unhealthy while the worker is frozen");
    assert.ok(heartbeatAge()! >= FRESH_MS);
    assert.ok(!existsSync(release), "the worker was held frozen until the check returned");

    // Only now release it. It must report in again by itself.
    const frozenBeat = heartbeatAt()!;
    writeFileSync(release, "go", { flag: "wx" });
    await until(
      () => (heartbeatAt() ?? 0) > frozenBeat,
      60_000,
      "a new heartbeat after the freeze",
    );
    assert.ok((heartbeatAge() ?? Infinity) < FRESH_MS);
    assert.equal(await check(env), 0, "healthy again once it is running");
  } finally {
    // Bounded cleanup of this test's own fixture files, by exact name, then
    // the (now empty) directory. Releasing first lets the worker leave its wait
    // and handle the shutdown message.
    if (!existsSync(release)) writeFileSync(release, "go");
    try {
      worker.child.send("shutdown");
    } catch {
      // Already gone.
    }
    await worker.exited;
    for (const file of [ack, release]) if (existsSync(file)) unlinkSync(file);
    rmdirSync(realFreezeDir);
  }
});

test("shutdown with a send in flight: the relay connection closes, the message is queued again, the worker exits well inside the bound", async () => {
  reset();
  relay.mode = "hang";
  const user = await newUser("term");
  db.exec("DELETE FROM mail_outbox");
  await enqueue(user, "term-1");
  // Production-like 45 s send deadline: the exit must come from the shutdown,
  // not from the deadline.
  const worker = startWorker({
    STYLE_MAIL_SEND_TIMEOUT_MS: "45000",
    STYLE_MAIL_HEARTBEAT_MS: "200",
  });
  try {
    await until(() => relay.connections === 1, 30_000, "the send to be in flight");
    assert.equal(relay.closed, 0);
    const requested = Date.now();
    worker.child.send("shutdown");
    const code = await worker.exited;
    const elapsed = Date.now() - requested;
    assert.equal(code, 0, "clean exit, not the hard-exit path");
    const l = (await import("../src/server/limits")).mailLimits();
    assert.ok(
      elapsed < l.shutdownExitMs,
      `exited within the documented bound (${elapsed} ms < ${l.shutdownExitMs} ms)`,
    );
    assert.ok(elapsed < 10_000, `and promptly (${elapsed} ms)`);
    await until(() => relay.closed === 1, 2_000, "the relay to see the socket close");
  } finally {
    if (children.size) for (const c of children) c.kill();
  }
  const [row] = rowsByStatus();
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error_code, "shutdown");
  assert.equal(row.lease_until, null);
  assert.equal(row.to_address, user.email);
  assert.match(worker.stderr(), /interrupted by shutdown for message/);
  assert.doesNotMatch(
    worker.stderr() + worker.stdout(),
    /@example\.test|token=|https?:\/\//,
    "nothing sensitive reaches the logs",
  );

  // Reclaim: the next worker delivers it (once).
  relay.mode = "ok";
  assert.equal(await m.processNextMail(), true);
  assert.equal(rowsByStatus()[0].status, "sent");
  assert.equal(relay.received, 1);
  reset();
});
