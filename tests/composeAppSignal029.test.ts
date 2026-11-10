import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DOCKER_DEFAULT_STOP_GRACE_MS,
  PID1_CMDLINE_COMMAND,
  PROMPT_STOP_LIMIT_MS,
  SIGKILL_EXIT_CODE,
  composeArgs,
  overrideProblems,
  pid1IsNextServer,
  stopArgs,
  stopProblems,
} from "../scripts/ci-compose-smoke-plan";

/**
 * Build 029: the app container's start command ends `exec node server.js`, so the server (not a shell) is PID 1 and
 * receives SIGTERM from `docker stop`. These tests pin the exact command order and run the real command text in a
 * POSIX shell with stand-ins for init-auth and the server. They run no Docker; the Docker proof is the new stop
 * check in scripts/ci-compose-smoke.ts, which has not run yet.
 */

const root = process.cwd();
const read = (f: string) => readFileSync(path.join(root, f), "utf8");

/** The text of the `app:` service of compose.yaml (up to the next top-level service). */
function appBlock(): string {
  const compose = read("compose.yaml").replace(/\r\n/g, "\n");
  const start = compose.indexOf("\n  app:\n");
  const end = compose.indexOf("\n  worker:\n");
  assert.ok(start >= 0 && end > start, "app service found");
  return compose.slice(start, end);
}

/** The app start script as the container's sh receives it: Compose turns `$$` into `$`. */
function appScript(): string {
  const m = /command:\n\s+- sh\n\s+- -c\n\s+- '([^\n]*)'\n/.exec(appBlock());
  assert.ok(m, "the app command is sh -c '<script>'");
  return m[1].replace(/\$\$/g, "$");
}

const INIT = "./node_modules/.bin/tsx scripts/init-auth.ts";
const hasSh = (() => {
  try {
    return spawnSync("sh", ["-c", "exit 0"]).status === 0;
  } catch {
    return false;
  }
})();

// ------------------------------------------------------------------ exact command order

test("the app command ends with init-auth && exec node server.js, in that order, as the only launch", () => {
  const script = appScript();
  assert.ok(script.endsWith(`${INIT} && exec node server.js`), "the tail is exactly: init-auth && exec node server.js");
  assert.equal((script.match(/\bexec\b/g) ?? []).length, 1, "exactly one exec");
  assert.equal((script.match(/node server\.js/g) ?? []).length, 1, "the server is started once");
  assert.equal((script.match(/init-auth\.ts/g) ?? []).length, 1, "init-auth runs once");
  const iInit = script.indexOf("init-auth.ts");
  const iExec = script.indexOf("exec node server.js");
  assert.ok(iInit < iExec, "init-auth comes before the exec");
  // nothing between them but the && that makes the exec conditional on init-auth's exit status 0
  assert.equal(script.slice(iInit + "init-auth.ts".length, iExec), " && ", "init-auth and exec are joined by && only");
  assert.ok(!/init-auth\.ts\s*(;|\|\||&(?!&)|$)/.test(script), "init-auth is never followed by ; || or a background &");
  assert.ok(!/\|\|\s*true/.test(script), "no failure is swallowed");
  assert.ok(!/exec\s+(\.\/node_modules\/\.bin\/)?tsx/.test(script), "init-auth is not exec'd (it must return so the server can start after it)");
  assert.ok(!/node server\.js\s*(&|;)/.test(script), "the server is not backgrounded or followed by anything");
});

test("every startup guard still runs before init-auth and the exec, unchanged", () => {
  const script = appScript();
  const iInit = script.indexOf("init-auth.ts");
  assert.ok(script.lastIndexOf("exit 1") < iInit, "every refusal comes before init-auth");
  assert.match(script, /^if \[ -n "\$STYLE_BODY_READ_TIMEOUT_MS" \]; then echo "STYLE_BODY_READ_TIMEOUT_MS is set in \.env\.production[^"]*" >&2; exit 1; fi; case /);
  assert.match(script, /STYLE_BODY_READ_TIMEOUT_MS="\$STYLE_COMPOSE_BODY_READ_TIMEOUT_MS"; export STYLE_BODY_READ_TIMEOUT_MS; \.\/node_modules\/\.bin\/tsx scripts\/init-auth\.ts && exec node server\.js$/);
  // the guard text is the same one the proxy applies (the existing proxy tests compare them); exec adds no new statement before it
  assert.equal(script.replace(" && exec node server.js", " && node server.js").endsWith(`${INIT} && node server.js`), true);
});

test("no setting hides the signal path: no init, stop_signal or custom grace period on the app service", () => {
  const block = appBlock().replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(block, /^\s+init:/m, "no Docker init process (the smoke test expects the server itself to be PID 1)");
  assert.doesNotMatch(block, /stop_signal:/);
  assert.doesNotMatch(block, /stop_grace_period:/, "the app uses Docker's default grace period, which the smoke test measures against");
  assert.match(block, /depends_on:/);
});

test("the CI-only override changes none of this: it sets no command, init or grace period for the app", () => {
  const override = read("deploy/ci/compose.smoke.yaml").replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(override, /init-auth|exec node|stop_grace_period|stop_signal|^\s+init:/m);
  // The faithful-compose allowlist is unchanged and still rejects a different app command or grace period.
  const shipped = { services: { app: { command: ["sh", "-c", "a"], image: "x" } } };
  assert.deepEqual(overrideProblems(shipped as never, { services: { app: { command: ["sh", "-c", "a"], image: "y" } } } as never), [], "the image may differ (allow-listed)");
  assert.deepEqual(overrideProblems(shipped as never, { services: { app: { command: ["sh", "-c", "b"], image: "x" } } } as never), ["changed services.app.command"]);
  assert.deepEqual(overrideProblems(shipped as never, { services: { app: { command: ["sh", "-c", "a"], image: "x", stop_grace_period: "1s" } } } as never), ["changed services.app.stop_grace_period"]);
});

test("the plain CI app container (docker job) starts the same way", () => {
  assert.match(read(".github/workflows/ci.yml"), /sh -c "\.\/node_modules\/\.bin\/tsx scripts\/init-auth\.ts && exec node server\.js"/);
});

// ------------------------------------------------------------------ the real command text in sh, with stand-ins

/** The shipped script with init-auth and the server replaced by stand-ins; the shell's pid is echoed first. */
function standIn(init: string, server: string): string {
  const script = appScript();
  assert.ok(script.includes(INIT) && script.includes("exec node server.js"));
  // function replacers: a plain string replacement would turn `$$` (the shell's pid) into a single `$`
  return `echo SHELL=$$; ${script.replace(INIT, () => init).replace("exec node server.js", () => server)}`;
}
/** A minimal environment (no host variable can reach the script): only PATH and the one value the start command reads. */
function shellEnv(composeBodyMs: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", PATH: process.env.PATH, STYLE_COMPOSE_BODY_READ_TIMEOUT_MS: composeBodyMs };
}
function runSh(script: string, timeoutMs = 10_000) {
  const r = spawnSync("sh", ["-c", script], { env: shellEnv("20000"), encoding: "utf8", timeout: timeoutMs });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const line = (out: string, key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(out)?.[1];

test("init-auth failing stops the container with its exit code and the server is never started (needs sh)", (t) => {
  if (!hasSh) return t.skip("no sh on this host");
  const dir = mkdtempSync(path.join(os.tmpdir(), "s029-"));
  try {
    const marker = path.join(dir, "server-started").replace(/\\/g, "/");
    for (const code of [1, 3, 70]) {
      const r = runSh(standIn(`sh -c 'echo INIT_RAN; exit ${code}'`, `exec sh -c 'echo SERVER_STARTED; : > "${marker}"'`));
      assert.equal(r.status, code, `exit status ${code} is kept (fail closed)`);
      assert.match(r.out, /INIT_RAN/);
      assert.doesNotMatch(r.out, /SERVER_STARTED/, "the server never starts after a failed init-auth");
      assert.equal(existsSync(marker), false);
    }
    // a refusal by the guards happens before init-auth is even attempted
    const refused = spawnSync("sh", ["-c", standIn("echo INIT_RAN", "exec echo SERVER_STARTED")], { env: shellEnv("999"), encoding: "utf8" });
    assert.equal(refused.status, 1);
    assert.doesNotMatch(refused.stdout, /INIT_RAN|SERVER_STARTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init-auth succeeding runs first, then the server REPLACES the shell (same process id), unlike the old form (needs sh)", (t) => {
  if (!hasSh) return t.skip("no sh on this host");
  const withExec = runSh(standIn("echo INIT_RAN", "exec sh -c 'echo SERVER=$$'"));
  assert.equal(withExec.status, 0, withExec.err);
  assert.ok(withExec.out.indexOf("INIT_RAN") < withExec.out.indexOf("SERVER="), "init-auth ran before the server");
  const shell = line(withExec.out, "SHELL");
  const server = line(withExec.out, "SERVER");
  assert.ok(shell && server);
  assert.equal(server, shell, "exec: the server process IS the container's first process (what Docker signals)");
  // The control, so the equality above means something: a server started as a plain child (no exec; the `; true` stops
  // a shell from exec-ing a last command on its own) has another pid than the shell that started it.
  const child = runSh(standIn("echo INIT_RAN", "sh -c 'echo SERVER=$$'; true"));
  assert.equal(child.status, 0, child.err);
  assert.notEqual(line(child.out, "SERVER"), line(child.out, "SHELL"), "without exec the server is a child of the shell, not the first process");
});

test("SIGTERM sent to the container's first process reaches the server, which exits promptly on its own (needs sh; not Windows)", async (t) => {
  if (!hasSh) return t.skip("no sh on this host");
  if (process.platform === "win32") return t.skip("Node cannot deliver SIGTERM to a process on Windows; this runs on Linux/macOS (CI)");
  const server = `exec sh -c 'trap "echo TERM_RECEIVED; exit 0" TERM; echo READY; while :; do sleep 0.1; done'`;
  // Typed as the general ChildProcess: the stdio tuple would otherwise narrow the stream types to never.
  const child: ChildProcess = spawn("sh", ["-c", standIn("true", server)], { env: shellEnv("20000"), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += String(d)));
  const deadline = Date.now() + 5000;
  while (!out.includes("READY") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(out.includes("READY"), "the stand-in server is running");
  const sent = Date.now();
  child.kill("SIGTERM");
  const code = await new Promise<number | null>((resolve) => child.on("close", (c: number | null) => resolve(c)));
  assert.ok(Date.now() - sent < 3000, "stopped promptly, not after a grace period");
  assert.equal(code, 0);
  assert.match(out, /TERM_RECEIVED/, "the server itself received the signal");
});

// ------------------------------------------------------------------ the CI measurement's pure parts

test("PID 1 is recognised as the Next server and never as a shell or launcher", () => {
  assert.equal(pid1IsNextServer("next-server (v15.5.27)\0\0"), true);
  assert.equal(pid1IsNextServer("next-server (v\0"), true, "the truncated title Linux may report");
  assert.equal(pid1IsNextServer("node\0server.js\0"), true, "before Next applies its title");
  assert.equal(pid1IsNextServer("/usr/local/bin/node\0server.js\0"), true);
  for (const bad of ["", "\0", "sh\0-c\0./node_modules/.bin/tsx scripts/init-auth.ts && node server.js\0", "/bin/sh\0-c\0node server.js\0", "node\0other.js\0", "node\0server.js\0--extra\0", "tsx\0scripts/analysis-worker.ts\0", "next-server-helper (v1)\0", "xnext-server (v15)\0", "next-server\0"])
    assert.equal(pid1IsNextServer(bad), false, JSON.stringify(bad));
  assert.deepEqual(PID1_CMDLINE_COMMAND, ["cat", "/proc/1/cmdline"], "only the command line is read; no environment, so nothing secret");
});

test("a measured stop counts as prompt only if it is fast, exited, and not SIGKILLed", () => {
  assert.deepEqual(stopProblems({ elapsedMs: 900, exitCode: 0, state: "exited" }), []);
  assert.deepEqual(stopProblems({ elapsedMs: 1200, exitCode: 143, state: "exited" }), [], "a SIGTERM exit code is fine");
  const killed = stopProblems({ elapsedMs: 10_400, exitCode: SIGKILL_EXIT_CODE, state: "exited" });
  assert.equal(killed.length, 2, "the old behaviour fails on both the time and the SIGKILL exit code");
  assert.ok(killed.some((p) => /SIGKILL/.test(p)) && killed.some((p) => /prompt stop/.test(p)));
  assert.ok(stopProblems({ elapsedMs: PROMPT_STOP_LIMIT_MS, exitCode: 0, state: "exited" }).length === 1, "exactly the limit is too slow");
  assert.ok(stopProblems({ elapsedMs: 500, exitCode: null, state: null }).some((p) => /missing/.test(p)));
  assert.ok(stopProblems({ elapsedMs: 500, exitCode: 0, state: "running" }).length === 1);
  assert.ok(PROMPT_STOP_LIMIT_MS < DOCKER_DEFAULT_STOP_GRACE_MS, "the limit is under the default grace period, so a grace-period stop cannot pass");
  assert.equal(DOCKER_DEFAULT_STOP_GRACE_MS, 10_000);
});

test("the stop uses the shipped grace period: no --timeout flag, one service, same project arguments as every other step", () => {
  const args = stopArgs("style-smoke-abc", "/tmp/dir", "app");
  assert.deepEqual(args, composeArgs("style-smoke-abc", "/tmp/dir", ["stop", "app"]));
  assert.deepEqual(args.slice(-2), ["stop", "app"]);
  assert.ok(!args.includes("--timeout") && !args.includes("-t"));
  assert.ok(args.includes("style-smoke-abc"));
});

test("the smoke scenario measures the stop on the app service and keeps its secret scan and cleanup", () => {
  const smoke = read("scripts/ci-compose-smoke.ts");
  assert.match(smoke, /pid1IsNextServer\(pid1\)/);
  assert.match(smoke, /stopArgs\(project, dir, "app"\)/);
  assert.match(smoke, /stopProblems\(\{ elapsedMs: stopMs/);
  assert.ok(smoke.indexOf("stopArgs(project, dir, \"app\")") < smoke.indexOf("await down();"), "measured before the project is removed");
  assert.match(smoke, /exec\("app", PID1_CMDLINE_COMMAND\)/);
  // The stop step reads PID 1's command line and never its environment. Scoped to the stop step and to the PID 1
  // helper: other parts of these files legitimately read /proc/<pid>/environ (the timeout-wiring probes) and the
  // word "environment" appears in unrelated code and comments.
  const code = (s: string) => s.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  const stepStart = smoke.indexOf("the shipped app container stops promptly");
  const stepEnd = smoke.indexOf("ctx.http?.close();", stepStart);
  assert.ok(stepStart > 0 && stepEnd > stepStart, "the stop step was found");
  const stopStep = code(smoke.slice(stepStart, stepEnd));
  assert.match(stopStep, /exec\("app", PID1_CMDLINE_COMMAND\)/, "the step reads PID 1 through the cmdline command");
  assert.doesNotMatch(stopStep, /environ|PROC_ENV_SOURCE|PROXY_ENV_COMMAND/, "the stop step reads no environment");
  const plan = read("scripts/ci-compose-smoke-plan.ts");
  const helperStart = plan.indexOf("export const PID1_CMDLINE_COMMAND");
  const helperEnd = plan.indexOf("/** Reasons a measured stop");
  assert.ok(helperStart > 0 && helperEnd > helperStart, "the PID 1 helper was found");
  const helper = code(plan.slice(helperStart, helperEnd));
  assert.match(helper, /\/proc\/1\/cmdline/);
  assert.doesNotMatch(helper, /\/proc\/1\/environ|environ/, "the PID 1 helper never names the environment file");
});

// ------------------------------------------------------------------ documentation

test("the operator guide records the fix and the unrun state of the new CI check, without overclaiming", () => {
  const guide = read("docs/DEPLOYMENT.md");
  assert.match(guide, /Build 029 fixes it/);
  assert.match(guide, /exec node server\.js/);
  assert.doesNotMatch(guide, /One thing it does not fix/, "the stale known-issue sentence is gone");
  assert.match(guide, /has not run yet/i, "the new CI check is not claimed as run");
  assert.match(guide, /42755324291/);
  assert.match(guide, /not run on an operator host|nothing here has run on an operator host/i);
  assert.ok(existsSync(path.join(root, "docs/reviews/implementation-029-notes.md")));
  const notes = read("docs/reviews/implementation-029-notes.md");
  assert.match(notes, /not launch-ready/i);
  assert.match(notes, /operator host/i);
  assert.match(notes, /public domain/i);
  for (const f of ["docs/DEPLOYMENT.md", "docs/reviews/implementation-029-notes.md"])
    for (const l of read(f).split("\n"))
      if (/ready to launch|launch[- ]ready|launch readiness|production[- ]ready/i.test(l)) assert.match(l, /no claim|not |never|cannot|until|remain|open|unverified|without/i, `${f}: ${l.slice(0, 120)}`);
});
