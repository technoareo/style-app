import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ALLOWED_OVERRIDE_DIFFS,
  AUTH_LOCK_MS,
  CADDY_SERVERS_COMMAND,
  DIRECT_PROBE_SOURCE,
  LOCK_HOLDER_SOURCE,
  PROC_ENV_SOURCE,
  PROXY_ENV_COMMAND,
  REFUSAL,
  SECURITY_HEADERS,
  SMOKE_APP_URL,
  SMOKE_DOMAIN,
  SMOKE_HTTPS_PORT,
  SMOKE_HTTP_PORT,
  SMOKE_PREFIX,
  appEnvFile,
  assertCleanEnvironment,
  bodyTimeoutAccepted,
  caddyTimeoutFacts,
  caddyTimeoutProblems,
  compareHeaders,
  composeArgs,
  composeSupportsOverride,
  configArgs,
  diffPaths,
  downArgs,
  execArgs,
  generateAuthSecret,
  listByNameArgs,
  overrideProblems,
  makeRunId,
  parseComposeVersion,
  projectEnvFile,
  proxyCapSeconds,
  runNoDepsArgs,
  smokeNames,
  stalledWindowMs,
  unexpectedDiffs,
  upArgs,
} from "../scripts/ci-compose-smoke-plan";
import { captureLogs, cleanupAll, parsePs, realHttp, runSmoke, type Scenario } from "../scripts/ci-compose-smoke";
import type { DockerResult } from "../scripts/ci-backup-drill";

/**
 * Build 023: the contract of the CI Compose + Caddy smoke test. Docker is not
 * available where these run, so they pin what can be pinned deterministically:
 * the override's reach, the shell rules the smoke test mirrors (run against the
 * REAL compose.yaml text where a POSIX sh exists), the comparison rules, the
 * in-container probe programs (run for real against local servers and a real
 * SQLite file), the HTTP client, the cleanup guarantees under failure (with a
 * fake docker that tracks resources) and the workflow wiring. The smoke test
 * itself runs in GitHub's Ubuntu/Docker job; this file does not claim it has.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const run = (source: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, ["-e", source, ...args], { env: { ...process.env, ...env }, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

test("run ids and project names are fixed-shape; a bad id is refused", () => {
  assert.match(makeRunId(), /^[0-9a-f]{10}$/);
  assert.equal(smokeNames("0123456789").project, `${SMOKE_PREFIX}0123456789`);
  for (const bad of ["", "../x", "ABC123", "12 34", "a".repeat(40)]) assert.throws(() => smokeNames(bad), /Invalid smoke run id/);
});

test("the body-timeout rule and the +2 s derivation match the shell text in compose.yaml (needs sh)", (t) => {
  if (!hasSh) return t.skip("no POSIX sh");
  const compose = read("compose.yaml").replace(/\$\$/g, "$");
  const check = /case "\$STYLE_COMPOSE_BODY_READ_TIMEOUT_MS" in .*? exit 1; fi;/.exec(compose)?.[0];
  assert.ok(check, "the compose start command has the check");
  const values = ["", "abc", "0999", "999", "1000", "9999", "20000", "20000s", "1e4", "0x4e20", " 20000", "+20000", "20.5", "1001", "119999", "120000", "120001", "130000", "999999", "1000000", "1234567", "00001"];
  for (const value of values) {
    const r: SpawnSyncReturns<string> = spawnSync("sh", ["-c", `${check} echo accepted`], { env: { ...process.env, STYLE_COMPOSE_BODY_READ_TIMEOUT_MS: value }, encoding: "utf8" });
    assert.equal(r.status === 0 && r.stdout.includes("accepted"), bodyTimeoutAccepted(value), `value ${JSON.stringify(value)}`);
  }
  const derive = /STYLE_PROXY_BODY_READ_TIMEOUT_S=(\$\(\( .*? \)\));/.exec(compose)?.[1];
  assert.ok(derive, "the proxy start command derives the cap");
  for (const ms of [1000, 1001, 19999, 20000, 20001, 30000, 60000, 119999, 120000]) {
    const r: SpawnSyncReturns<string> = spawnSync("sh", ["-c", `STYLE_COMPOSE_BODY_READ_TIMEOUT_MS=${ms}; echo ${derive}`], { encoding: "utf8" });
    assert.equal(Number(r.stdout.trim()), proxyCapSeconds(ms), `cap for ${ms}`);
    assert.equal(proxyCapSeconds(ms), Math.ceil(ms / 1000) + 2);
  }
  assert.deepEqual([20000, 30000, 60000, 120000].map(proxyCapSeconds), [22, 32, 62, 122]);
});

test("the accepted range is exactly 1000..120000 whole milliseconds (the documented rule), for every integer around and beyond it", () => {
  for (let n = 0; n <= 200_000; n++) assert.equal(bodyTimeoutAccepted(String(n)), n >= 1000 && n <= 120_000, String(n));
  for (const text of ["", "01000", "+1000", "1000.0", " 1000", "1000 ", "1,000", "1e3", "0x3e8", "٢٠٠٠٠"]) assert.equal(bodyTimeoutAccepted(text), false, JSON.stringify(text));
  assert.match(read("docs/DEPLOYMENT.md"), /whole milliseconds from 1000 to 120000/);
  assert.match(read("src/server/limits.ts"), /"STYLE_BODY_READ_TIMEOUT_MS",\s*20_000,\s*1000,\s*120_000/);
});

test("the refusal texts and security headers the smoke test expects are the ones the shipped files contain", () => {
  const compose = read("compose.yaml");
  for (const text of Object.values(REFUSAL)) assert.ok(compose.includes(text), `compose.yaml contains: ${text}`);
  const caddy = read("deploy/Caddyfile");
  const block = /header \{([\s\S]*?)\n  \}/.exec(caddy)?.[1] ?? "";
  const shipped = Object.fromEntries(
    block
      .split("\n")
      .map((l) => /^\s*([A-Za-z-]+)\s+"(.*)"\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1].toLowerCase(), m[2]]),
  );
  assert.deepEqual(shipped, SECURITY_HEADERS);
  assert.ok(caddy.includes("protocols h1"));
  assert.ok(caddy.includes("{$STYLE_DOMAIN} {"), "the site address comes from STYLE_DOMAIN, so a .localhost name uses Caddy's internal CA");
});

test("the test site name is acceptable to a public-deployment APP_URL and is Caddy-local", () => {
  const url = new URL(SMOKE_APP_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.origin, SMOKE_APP_URL);
  // src/server/auth.ts refuses exactly these names for a public deployment.
  assert.ok(!["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(url.hostname));
  // Caddy serves *.localhost from its own CA and never asks a public one.
  assert.ok(SMOKE_DOMAIN.endsWith(".localhost") && (SMOKE_DOMAIN as string) !== "localhost");
  assert.equal(url.hostname, SMOKE_DOMAIN);
  assert.equal(Number(url.port), SMOKE_HTTPS_PORT);
});

test("generated env files: strong random secret, placeholder SMTP, short auth lock, no timeout unless asked", () => {
  const a = generateAuthSecret();
  const b = generateAuthSecret();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.deepEqual(generateAuthSecret(() => Buffer.alloc(36, 1)), generateAuthSecret(() => Buffer.alloc(36, 1)));
  const env = appEnvFile({ authSecret: a });
  for (const line of [`AUTH_SECRET=${a}`, `APP_URL=${SMOKE_APP_URL}`, "SMTP_URL=smtp://127.0.0.1:2525", `STYLE_AUTH_LOCK_MS=${AUTH_LOCK_MS}`]) assert.ok(env.includes(line), line);
  assert.match(env, /MAIL_FROM=/);
  assert.doesNotMatch(env, /STYLE_BODY_READ_TIMEOUT_MS|STYLE_PUBLIC_DEPLOYMENT/, "compose sets STYLE_PUBLIC_DEPLOYMENT; the timeout belongs in the project .env");
  assert.ok(appEnvFile({ authSecret: a, extraLines: ["STYLE_BODY_READ_TIMEOUT_MS=30000"] }).includes("STYLE_BODY_READ_TIMEOUT_MS=30000"));
  assert.throws(() => appEnvFile({ authSecret: "short" }), /at least 32/);
  assert.ok(AUTH_LOCK_MS >= 100 && AUTH_LOCK_MS <= 60_000, "inside the range src/server/auth.ts accepts");

  assert.equal(projectEnvFile().trim().split("\n").filter((l) => !l.startsWith("#")).join("|"), `STYLE_DOMAIN=${SMOKE_DOMAIN}`);
  assert.match(projectEnvFile({ bodyTimeout: "30000" }), /^STYLE_BODY_READ_TIMEOUT_MS=30000$/m);
  assert.match(projectEnvFile({ bodyTimeout: "" }), /^STYLE_BODY_READ_TIMEOUT_MS=$/m);
  assert.doesNotMatch(projectEnvFile({ domain: null }), /STYLE_DOMAIN/);
  assert.doesNotMatch(projectEnvFile({ bodyTimeout: "abc" }), new RegExp(a));
});

test("a shell value for the tested variables is refused: it would override the project .env", () => {
  assertCleanEnvironment({ PATH: "x" });
  for (const k of ["STYLE_DOMAIN", "STYLE_BODY_READ_TIMEOUT_MS", "STYLE_COMPOSE_BODY_READ_TIMEOUT_MS", "STYLE_PROXY_BODY_READ_TIMEOUT_S"])
    assert.throws(() => assertCleanEnvironment({ [k]: "" }), new RegExp(k));
});

test("compose argument lists: one project name, both files, no worker or mailer, nothing built or pulled", () => {
  const dir = path.join(os.tmpdir(), "p");
  const withOverride = composeArgs("proj", dir, ["ps"]);
  assert.deepEqual(withOverride.slice(0, 3), ["compose", "-p", "proj"]);
  assert.equal(withOverride.filter((a) => a === "-f").length, 2);
  assert.equal(composeArgs("proj", dir, ["ps"], false).filter((a) => a === "-f").length, 1);
  assert.ok(configArgs("proj", dir, true).includes("json"));
  const up = upArgs("proj", dir);
  assert.deepEqual(up.slice(-2), ["app", "proxy"]);
  assert.ok(up.includes("--no-build") && up.includes("--wait"));
  assert.ok(!up.includes("worker") && !up.includes("mailer") && !up.includes("ollama"));
  assert.ok(execArgs("proj", dir, "app", ["node", "-e", "x"]).includes("-T"));
  const one = runNoDepsArgs("proj", dir, "proxy");
  assert.ok(one.includes("--no-deps") && one.includes("--rm") && one.at(-1) === "proxy");
  assert.ok(!one.includes("--service-ports"));
  const down = downArgs("proj", dir);
  assert.ok(down.includes("-v") && down.includes("--remove-orphans"));
  assert.deepEqual(listByNameArgs("volume", smokeNames("abcdef12")), ["volume", "ls", "-q", "--filter", `name=${SMOKE_PREFIX}abcdef12`]);
  assert.ok(listByNameArgs("container").includes(`name=${SMOKE_PREFIX}`));
  assert.deepEqual(parseComposeVersion("Docker Compose version v2.29.7"), [2, 29, 7]);
  assert.ok(composeSupportsOverride("Docker Compose version v2.24.0"));
  assert.ok(!composeSupportsOverride("Docker Compose version v2.23.3"));
  assert.ok(!composeSupportsOverride("nonsense"));
  assert.ok(composeSupportsOverride("Docker Compose version 3.0.0"));
});

test("the override file can only change what the runner allows, and publishes only the ports the plan names", () => {
  const text = read("deploy/ci/compose.smoke.yaml");
  const code = text.replace(/^\s*#.*$/gm, "");
  assert.match(code, /^services:$/m);
  assert.deepEqual(code.match(/^[a-z_]+:/gm), ["services:"], "only the services key at the top");
  const blocks = new Map<string, string[]>();
  let current = "";
  for (const line of code.split("\n")) {
    const service = /^  ([a-z]+):\s*$/.exec(line);
    if (service) {
      current = service[1];
      blocks.set(current, []);
    } else if (current) {
      const key = /^    ([a-z_]+):/.exec(line);
      if (key) blocks.get(current)?.push(key[1]);
    }
  }
  const allowed: Record<string, string[]> = {
    app: ["image", "pull_policy", "restart"],
    worker: ["image", "pull_policy"],
    mailer: ["image", "pull_policy"],
    proxy: ["restart", "ports"],
  };
  for (const [service, keys] of blocks) {
    if (service === "ollama") continue; // the mock model: wholly replaced, nothing shipped depends on its details
    assert.ok(allowed[service], `unexpected service ${service}`);
    for (const key of keys) assert.ok(allowed[service].includes(key), `${service}.${key} is not allowed`);
    for (const key of keys) assert.ok(ALLOWED_OVERRIDE_DIFFS.some((rule) => rule === `services.${service}.${key}`), `${service}.${key} is not on the runner's allow-list`);
  }
  assert.ok(ALLOWED_OVERRIDE_DIFFS.includes("services.ollama."));
  assert.match(code, /ports: !override/);
  assert.match(code, /volumes: !override/);
  assert.match(code, new RegExp(`"127\\.0\\.0\\.1:${SMOKE_HTTP_PORT}:80"`));
  assert.match(code, new RegExp(`"127\\.0\\.0\\.1:${SMOKE_HTTPS_PORT}:443"`));
  assert.equal((code.match(/image: style-studio:ci/g) ?? []).length, 3, "exactly app, worker and mailer use the CI image");
  assert.match(code, /mock-ollama\.mjs:\/mock\.mjs:ro/);
  assert.ok(existsSync(path.join(process.cwd(), "deploy/ci/mock-ollama.mjs")));
});

test("config differences: allowed ones pass, anything about the shipped commands, mounts or limits fails", () => {
  const base = {
    services: {
      app: { command: ["sh", "-c", "x"], environment: { A: "1" }, healthcheck: { test: ["CMD", "y"] }, cap_drop: ["ALL"] },
      proxy: { command: ["sh", "-c", "z"], ports: [{ published: "443" }], volumes: ["a"] },
      ollama: { image: "ollama/ollama:0.40.3", volumes: ["m"] },
      worker: {},
    },
  };
  const copy = () => JSON.parse(JSON.stringify(base));
  const ok = copy();
  ok.services.app.image = "style-studio:ci";
  ok.services.app.pull_policy = "never";
  ok.services.app.restart = "no";
  ok.services.proxy.ports = [{ published: "18443" }];
  ok.services.proxy.restart = "no";
  ok.services.ollama = { image: "node", command: ["node"], volumes: ["x"] };
  ok.services.worker.image = "style-studio:ci";
  assert.deepEqual(unexpectedDiffs(diffPaths(base, ok)), []);
  const mutations: [string, (c: any) => void, string][] = [
    ["app command", (c) => (c.services.app.command = ["sh", "-c", "other"]), "services.app.command"],
    ["app env", (c) => (c.services.app.environment.A = "2"), "services.app.environment.A"],
    ["added env", (c) => (c.services.app.environment.B = "2"), "services.app.environment.B"],
    ["healthcheck", (c) => delete c.services.app.healthcheck, "services.app.healthcheck"],
    ["cap_drop", (c) => (c.services.app.cap_drop = []), "services.app.cap_drop"],
    ["proxy command", (c) => (c.services.proxy.command = ["x"]), "services.proxy.command"],
    ["proxy mounts", (c) => (c.services.proxy.volumes = ["b"]), "services.proxy.volumes"],
    ["a new service", (c) => (c.services.extra = { image: "x" }), "services.extra"],
  ];
  for (const [label, mutate, expected] of mutations) {
    const changed = copy();
    mutate(changed);
    assert.deepEqual(unexpectedDiffs(diffPaths(base, changed)), [expected], label);
  }
});

const APP_JSON = ["Content-Type", "application/json", "Cache-Control", "private, no-store", "X-Content-Type-Options", "nosniff"];
// What Caddy adds: the four Caddyfile headers the app does not send itself, its own Server and Via.
const ADDED = [
  ...Object.entries(SECURITY_HEADERS).filter(([name]) => name !== "x-content-type-options").flat(),
  "Server",
  "Caddy",
  "Via",
  "1.1 Caddy",
];
const PROXIED = [...APP_JSON, ...ADDED, "Connection", "close", "Date", "now"];
const without = (headers: string[], name: string) => headers.filter((_, i) => headers[i - (i % 2)].toLowerCase() !== name.toLowerCase());

test("header comparison: a faithful proxy passes; duplicates, losses, extras, a missing close and missing security headers fail", () => {
  const problems = (direct: string[], proxied: string[], expectClose = true) => compareHeaders(direct, proxied, { expectClose }).join(";");
  assert.deepEqual(compareHeaders([...APP_JSON, "Date", "then", "Content-Length", "5"], PROXIED, { expectClose: true }), []);
  assert.match(problems(APP_JSON, [...PROXIED, "Cache-Control", "private, no-store"]), /cache-control.*(changed|2 times)/i);
  assert.match(problems([...APP_JSON, "Retry-After", "5"], PROXIED), /"retry-after" was lost/);
  assert.match(problems([...APP_JSON, "Retry-After", "5"], [...PROXIED, "Retry-After", "30"]), /"retry-after" changed/);
  assert.match(problems(APP_JSON, [...PROXIED, "X-Surprise", "1"]), /unexpected header "x-surprise"/);
  assert.match(problems(APP_JSON, without(PROXIED, "Connection")), /Connection: close/);
  assert.match(problems(APP_JSON, [...APP_JSON, "Connection", "close"]), /missing security header/);
  assert.match(problems(APP_JSON, PROXIED, false), /unexpectedly said Connection: close/);
  assert.deepEqual(compareHeaders(APP_JSON, without(PROXIED, "Connection"), { expectClose: false }), []);
  assert.match(problems(APP_JSON, PROXIED.map((v) => (v === "DENY" ? "SAMEORIGIN" : v))), /x-frame-options.*expected "DENY"/);
  // Vary: the proxy may add Accept-Encoding but must keep the app's tokens.
  const withVary = [...APP_JSON, "Vary", "RSC, Next-Router-State-Tree"];
  assert.deepEqual(compareHeaders(withVary, [...PROXIED, "Vary", "RSC, Next-Router-State-Tree, Accept-Encoding"], { expectClose: true }), []);
  assert.match(problems(withVary, [...PROXIED, "Vary", "Accept-Encoding"]), /Vary lost "rsc"/);
  assert.deepEqual(compareHeaders(APP_JSON, [...PROXIED, "Vary", "Accept-Encoding"], { expectClose: true }), []);
  // Several cookies are normal; a header the Caddyfile sets must not be doubled.
  const cookies = ["Set-Cookie", "a=1", "Set-Cookie", "b=2"];
  assert.deepEqual(compareHeaders([...APP_JSON, ...cookies], [...PROXIED, ...cookies], { expectClose: true }), []);
  assert.match(problems(APP_JSON, [...PROXIED, "Strict-Transport-Security", "max-age=31536000"]), /strict-transport-security/);
});

test("Caddy's running timeouts: values found by meaning, not by key name; wrong cap, protocols and header timeout are reported", () => {
  const servers = {
    srv0: { listen: [":443"], protocols: ["h1"], read_timeout: 22e9, read_header_timeout: 10e9, idle_timeout: 3e11, routes: [] },
    srv1: { listen: [":80"], protocols: ["h1"], read_timeout: 22e9 },
  };
  const { facts, raw } = caddyTimeoutFacts(servers);
  assert.deepEqual(facts, { protocols: ["h1"], readBodyNs: [22e9], readHeaderNs: [10e9] });
  assert.ok("idle_timeout" in raw === true);
  assert.deepEqual(caddyTimeoutProblems(facts, 20000), []);
  assert.match(caddyTimeoutProblems(facts, 30000).join(";"), /32 s/);
  assert.match(caddyTimeoutProblems({ ...facts, protocols: ["h1", "h2"] }, 20000).join(";"), /protocols/);
  assert.match(caddyTimeoutProblems({ ...facts, readHeaderNs: [5e9] }, 20000).join(";"), /header timeout/);
  assert.throws(() => caddyTimeoutFacts({ srv1: { listen: [":80"] } }), /:443/);
  assert.throws(() => caddyTimeoutFacts("x"), /not an object/);
  assert.deepEqual(stalledWindowMs(20000), { min: 18000, max: 21900 });
  assert.deepEqual(stalledWindowMs(30000), { min: 27000, max: 31900 });
  assert.ok(CADDY_SERVERS_COMMAND.at(-1)?.endsWith("/config/apps/http/servers"));
  assert.ok(PROXY_ENV_COMMAND.at(-1)?.includes("STYLE_PROXY_BODY_READ_TIMEOUT_S") && !/AUTH_SECRET|SMTP/.test(PROXY_ENV_COMMAND.join(" ")));
});

test("parsePs reads both shapes of `docker compose ps --format json`", () => {
  const row = { Service: "app", State: "exited", ExitCode: 1 };
  assert.deepEqual(parsePs(JSON.stringify([row])), [row]);
  assert.deepEqual(parsePs(JSON.stringify(row)), [row]);
  assert.deepEqual(parsePs(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, Service: "proxy" })}\n`).map((r) => r.Service), ["app", "proxy"]);
  assert.deepEqual(parsePs(""), []);
});

// The real merge shape (GitHub run 41091590200 failed with "changed settings it must not: volumes.model-data"): the override
// replaces ollama's mounts, nothing references the top-level model-data volume any more, and `docker compose config` leaves an
// unreferenced top-level volume out. The other three volumes stay.
const volumes = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { name: `style-smoke-abc_${n}` }]));
const shippedShape = () => ({
  name: "style-smoke-abc",
  services: {
    app: { command: ["sh", "-c", "x"], volumes: [{ type: "volume", source: "app-data", target: "/data" }], restart: "unless-stopped", ports: undefined },
    ollama: { image: "ollama/ollama:0.40.3", volumes: [{ type: "volume", source: "model-data", target: "/root/.ollama" }] },
    proxy: {
      command: ["sh", "-c", "y"],
      restart: "unless-stopped",
      ports: [{ mode: "ingress", target: 80, published: "80", protocol: "tcp" }],
      volumes: [
        { type: "bind", source: "/p/deploy/Caddyfile", target: "/etc/caddy/Caddyfile", read_only: true },
        { type: "volume", source: "proxy-data", target: "/data" },
        { type: "volume", source: "proxy-config", target: "/config" },
      ],
    },
  },
  volumes: volumes("app-data", "model-data", "proxy-data", "proxy-config"),
});
const mergedShape = () => {
  const m = JSON.parse(JSON.stringify(shippedShape()));
  m.services.app.image = "style-studio:ci";
  m.services.app.restart = "no";
  m.services.ollama = { image: "node:24-bookworm-slim", command: ["node", "/mock.mjs"], volumes: [{ type: "bind", source: "/p/deploy/ci/mock-ollama.mjs", target: "/mock.mjs", read_only: true }] };
  m.services.proxy.restart = "no";
  m.services.proxy.ports = [{ mode: "ingress", host_ip: "127.0.0.1", target: 80, published: "18080", protocol: "tcp" }];
  delete m.volumes["model-data"]; // what compose config does once no service uses it
  return m;
};

test("regression (run 41091590200): the real merge shape passes, because the unreferenced model-data volume is dropped; nothing else may drift", () => {
  const shipped = shippedShape();
  const merged = mergedShape();
  assert.deepEqual(diffPaths(shipped, merged).filter((p) => p.startsWith("volumes")), ["volumes.model-data"], "this is the exact path the CI run reported");
  assert.deepEqual(unexpectedDiffs(diffPaths(shipped, merged)), [], "the path is on the allow-list");
  assert.deepEqual(overrideProblems(shipped, merged), []);

  const problems = (mutate: (m: any) => void) => {
    const m = mergedShape();
    mutate(m);
    return overrideProblems(shipped, m);
  };
  // model-data may only be DROPPED, and only when nothing uses it.
  assert.match(problems((m) => (m.volumes["model-data"] = { name: "style-smoke-abc_model-data", driver: "local" })).join(";"), /model-data volume was changed/);
  assert.match(problems((m) => (m.services.ollama.volumes = [{ type: "volume", source: "model-data", target: "/root/.ollama" }])).join(";"), /still uses it/);
  assert.match(problems((m) => (m.services.app.volumes = [{ type: "volume", source: "model-data", target: "/data" }])).join(";"), /still uses it|changed services.app.volumes/);
  const noModel = shippedShape();
  delete (noModel.volumes as Record<string, unknown>)["model-data"];
  assert.match(overrideProblems(noModel, mergedShape()).join(";") || "none", /^none$/, "a shipped file without it makes the allowance unused, not wrong");
  const appeared = mergedShape();
  assert.match(overrideProblems(noModel, { ...appeared, volumes: { ...appeared.volumes, "model-data": { name: "x" } } }).join(";"), /appeared only in the merged config/);
  // The other production volumes are NOT covered by the allowance.
  for (const name of ["app-data", "proxy-data", "proxy-config"])
    assert.deepEqual(problems((m) => delete m.volumes[name]), [`changed volumes.${name}`], `dropping ${name} fails`);
  assert.deepEqual(problems((m) => (m.volumes["extra"] = { name: "x" })), ["changed volumes.extra"], "a new volume fails");
  assert.deepEqual(problems((m) => (m.volumes["app-data"] = { name: "other" })), ["changed volumes.app-data.name"]);
  // Production behaviour of app and proxy is still protected.
  assert.deepEqual(problems((m) => (m.services.app.command = ["sh", "-c", "z"])), ["changed services.app.command"]);
  assert.deepEqual(problems((m) => (m.services.proxy.volumes = [])), ["changed services.proxy.volumes"]);
  assert.deepEqual(problems((m) => (m.services.proxy.command = ["x"])), ["changed services.proxy.command"]);
});

test("regression: the allow-list names volumes.model-data exactly (no wildcard for volumes) and the override file still replaces only ollama's mounts", () => {
  assert.ok(ALLOWED_OVERRIDE_DIFFS.includes("volumes.model-data"));
  assert.deepEqual((ALLOWED_OVERRIDE_DIFFS as readonly string[]).filter((r) => r.startsWith("volumes")), ["volumes.model-data"], "no wildcard for volumes");
  const code = read("deploy/ci/compose.smoke.yaml").replace(/^\s*#.*$/gm, "");
  assert.equal((code.match(/volumes: !override/g) ?? []).length, 1, "one replaced mount list");
  assert.match(code, /ollama:[\s\S]*volumes: !override[\s\S]*mock-ollama\.mjs/);
  assert.doesNotMatch(code, /^volumes:/m, "no top-level volumes section in the override");
  assert.match(read("compose.yaml"), /^volumes:\n  app-data:\n  model-data:\n  proxy-data:\n  proxy-config:/m, "the shipped file declares these four");
});

// --- the programs that run inside the containers, run for real here -------------------

test("direct probe: sends method, path, headers and body to the app port and returns the RAW header list (duplicates kept)", async () => {
  let seen = { method: "", url: "", origin: "", body: "" };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = { method: req.method ?? "", url: req.url ?? "", origin: String(req.headers.origin), body: Buffer.concat(chunks).toString() };
      res.statusCode = 503;
      res.setHeader("Retry-After", "5");
      res.setHeader("Set-Cookie", ["a=1", "b=2"]);
      res.end('{"code":"busy"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = String((server.address() as AddressInfo).port);
    const r = await run(DIRECT_PROBE_SOURCE, ["POST", "/api/x?y=1", JSON.stringify({ origin: "https://o.test", "content-type": "application/json" }), Buffer.from('{"a":1}').toString("base64")], { PROBE_PORT: port });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.status, 503);
    assert.equal(out.body, '{"code":"busy"}');
    assert.deepEqual(seen, { method: "POST", url: "/api/x?y=1", origin: "https://o.test", body: '{"a":1}' });
    const names = (out.rawHeaders as string[]).filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
    assert.equal(names.filter((n) => n === "set-cookie").length, 2, "raw header list keeps both cookies");
    assert.ok(names.includes("retry-after"));
    const refused = await run(DIRECT_PROBE_SOURCE, ["GET", "/", "{}", ""], { PROBE_PORT: "1" });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /probe error/);
  } finally {
    server.close();
  }
});

test("lock holder: holds SQLite's write lock for the time given, prints LOCKED, then releases", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "smoke-lock-"));
  const file = path.join(dir, "app.db");
  const setup = new DatabaseSync(file);
  setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x)");
  setup.close();
  try {
    const child = execFile(process.execPath, ["-e", LOCK_HOLDER_SOURCE, "1500", file], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    for (let i = 0; i < 100 && !out.includes("LOCKED"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(out.includes("LOCKED"), "the holder reports the lock");
    const other = new DatabaseSync(file);
    other.exec("PRAGMA busy_timeout=0");
    assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked|busy/i, "a second writer is refused while it is held");
    other.prepare("SELECT count(*) FROM t").get(); // readers still work, as they do for the app's /api/health
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    assert.ok(out.includes("RELEASED"));
    other.exec("BEGIN IMMEDIATE");
    other.exec("ROLLBACK");
    other.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process-environment probe: finds the real next-server by its process title, never the probe, a shell or an unrelated process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "smoke-proc-"));
  const proc = (pid: string, cmd: string[], env: string[]) => {
    mkdirSync(path.join(root, pid));
    writeFileSync(path.join(root, pid, "cmdline"), cmd.join("\0"));
    writeFileSync(path.join(root, pid, "environ"), env.join("\0"));
  };
  const probe = async (self?: string) => {
    const r = await run(PROC_ENV_SOURCE, ["STYLE_BODY_READ_TIMEOUT_MS", "server.js", root, ...(self ? [self] : [])]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes("supersecret"), "no other environment value is ever printed");
    return JSON.parse(r.stdout.trim()) as { found: number; value: string | null };
  };
  try {
    // The container as it really is: PID 1 is the start shell (the variable is exported AFTER it started, so it is not in
    // its environment), the server is the child whose title Next set to "next-server (v15.5.27)" (padding after it is NULs).
    proc("1", ["sh", "-c", "export X; ./node_modules/.bin/tsx scripts/init-auth.ts && node server.js"], ["PATH=/bin"]);
    proc("27", ["next-server (v15.5.27)", "", ""], ["xt-server=clobbered", "AUTH_SECRET=supersecretvalue1234567890", "STYLE_BODY_READ_TIMEOUT_MS=30000"]);
    // Things that must NOT count, even though each carries the variable:
    proc("9", ["sh", "-c", "node server.js"], ["STYLE_BODY_READ_TIMEOUT_MS=11111"]); // a shell that merely mentions the script
    proc("40", ["node", "-e", "scan", "STYLE_BODY_READ_TIMEOUT_MS", "server.js"], ["STYLE_BODY_READ_TIMEOUT_MS=22222"]); // an exec'd probe
    proc("41", ["node", "other.js"], ["STYLE_BODY_READ_TIMEOUT_MS=33333"]); // another node program
    proc("42", ["next-server-helper (v1.0.0)"], ["STYLE_BODY_READ_TIMEOUT_MS=44444"]); // a similar-looking name
    proc("43", ["next-server"], ["STYLE_BODY_READ_TIMEOUT_MS=55555"]); // no version
    proc("45", ["next-server "], ["STYLE_BODY_READ_TIMEOUT_MS=88888"]); // the space alone
    proc("46", ["next-server (x1)"], ["STYLE_BODY_READ_TIMEOUT_MS=99999"]); // not a version
    proc("47", ["xnext-server (v15.5.27)"], ["STYLE_BODY_READ_TIMEOUT_MS=10101"]); // not at the start
    proc("44", ["node", "server.js", "--extra"], ["STYLE_BODY_READ_TIMEOUT_MS=66666"]); // not exactly the start command
    mkdirSync(path.join(root, "self"));
    assert.deepEqual(await probe(), { found: 1, value: "30000" });
    // Linux keeps a process title only as long as the original argument block. "node server.js" is 14 characters and
    // "next-server (v15.5.27)" is 22, so the kernel may report exactly "next-server (v" (14 characters). That is the real server too.
    assert.equal("node server.js".length, 14);
    assert.equal("next-server (v".length, 14);
    proc("61", ["next-server (v"], ["STYLE_BODY_READ_TIMEOUT_MS=30000"]);
    proc("62", ["next-server (v", "", ""], ["STYLE_BODY_READ_TIMEOUT_MS=30000"]); // with NUL padding after it
    assert.equal((await probe()).found, 3, "the full title and both truncated forms are the real server");
    for (const pid of ["61", "62"]) rmSync(path.join(root, pid), { recursive: true, force: true });
    // Before Next applies its title the command line is the start command; that form is recognised too.
    proc("60", ["/usr/local/bin/node", "server.js"], ["STYLE_BODY_READ_TIMEOUT_MS=30000"]);
    assert.equal((await probe()).found, 2, "two real servers are reported as two (the runner requires exactly 1)");
    // The probe excludes itself by PID even if its own title looks like the server (it must never count itself).
    assert.equal((await probe("60")).found, 1);
    assert.equal((await probe("27")).found, 1);
    rmSync(path.join(root, "27"), { recursive: true, force: true });
    rmSync(path.join(root, "60"), { recursive: true, force: true });
    proc("63", ["next-server (v"], ["PATH=/bin", "STYLE_BODY_READ_TIMEOUT_MS=45000"]);
    assert.deepEqual(await probe(), { found: 1, value: "45000" }, "a lone truncated title is found");
    rmSync(path.join(root, "63"), { recursive: true, force: true });
    assert.deepEqual(await probe(), { found: 0, value: null }, "no real server: nothing is guessed");
    // A server without the variable in its environment is not a match for the variable.
    proc("70", ["next-server (v15.5.27)"], ["PATH=/bin"]);
    assert.deepEqual(await probe(), { found: 0, value: null });
    // The real process's own pid is the default self: a probe that happens to be pid-equal is skipped.
    const own = String(process.pid);
    proc(own, ["next-server (v15.5.27)"], ["STYLE_BODY_READ_TIMEOUT_MS=77777"]);
    assert.deepEqual(await probe(own), { found: 0, value: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the HTTP client, against a plain local server ----------------------------------------

test("http client: keep-alive reuse, raw headers, the plain redirect port, and a stalled upload that gets a 408 and a close", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/stall") {
      req.once("data", () => {
        setTimeout(() => {
          res.statusCode = 408;
          res.setHeader("Connection", "close");
          res.end('{"error":"The request took too long. Please try again."}');
        }, 200);
      });
      return;
    }
    if (req.url === "/silent") return; // never answers
    res.setHeader("X-Dup", ["a", "b"]);
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const client = realHttp({ domain: SMOKE_DOMAIN, httpPort: port, httpsPort: port, scheme: "http" });
  try {
    const a = await client.request({ method: "GET", path: "/h", keepAlive: true });
    const b = await client.request({ method: "GET", path: "/h", keepAlive: true });
    assert.equal(a.status, 200);
    assert.equal(a.httpVersion, "1.1", "the HTTP version comes from the response");
    assert.equal(a.reusedSocket, false);
    assert.equal(b.reusedSocket, true);
    assert.equal(a.rawHeaders.filter((h) => h.toLowerCase() === "x-dup").length, 2);
    assert.equal((await client.request({ method: "GET", path: "/h", plain: true })).body, "ok");
    assert.equal(await client.alpn(["h2", "http/1.1"]), null);
    const stalled = await client.stalledUpload({ path: "/stall", declaredLength: 2000, timeoutMs: 5000 });
    assert.equal(stalled.status, 408);
    assert.match(stalled.body, /took too long/);
    assert.ok(stalled.elapsedMs >= 150 && stalled.elapsedMs < 2000);
    assert.notEqual(stalled.closedAfterMs, null, "the close after the 408 is observed");
    await assert.rejects(client.stalledUpload({ path: "/silent", declaredLength: 10, timeoutMs: 300 }), /No answer to the stalled upload/);
  } finally {
    client.close();
    server.closeAllConnections();
    server.close();
  }
});

// --- orchestration: cleanup under success and failure, with a fake docker --------------------

type Call = string[];
function fakeDocker(opts: { leftoverAfterRemoval?: boolean; logs?: string } = {}) {
  const calls: Call[] = [];
  const live = new Set<string>(["c1", "c2"]);
  const docker = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "ps" && args.includes("-aq")) return ok(opts.leftoverAfterRemoval ? "stuck\n" : [...live].join("\n"));
    if (args[0] === "rm") {
      live.delete(args.at(-1) ?? "");
      return ok();
    }
    if (args[0] === "compose" && args.includes("logs")) return ok(opts.logs ?? "");
    return ok();
  };
  return { docker, calls, live };
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "smoke-test-"));
const baseDeps = (docker: ReturnType<typeof fakeDocker>["docker"], extra = {}) => ({
  docker,
  log: () => undefined,
  env: {},
  tmpRoot: tmp,
  ...extra,
});

test("a passing run leaves nothing: project folder with the shipped files byte for byte, then down -v, name sweeps and removal", async () => {
  const f = fakeDocker();
  let projectDir = "";
  const scenario: Scenario = async (ctx) => {
    projectDir = ctx.dir;
    for (const file of ["compose.yaml", "deploy/Caddyfile", "deploy/ci/mock-ollama.mjs"])
      assert.equal(readFileSync(path.join(ctx.dir, file), "utf8"), read(file), `${file} is copied unchanged`);
    assert.equal(readFileSync(path.join(ctx.dir, "compose.smoke.yaml"), "utf8"), read("deploy/ci/compose.smoke.yaml"));
    assert.match(readFileSync(path.join(ctx.dir, ".env.production"), "utf8"), /^AUTH_SECRET=/m);
    assert.equal(readFileSync(path.join(ctx.dir, ".env"), "utf8"), projectEnvFile());
    await ctx.docker(["version"]);
  };
  await runSmoke(baseDeps(f.docker), scenario);
  assert.equal(existsSync(projectDir), false, "the project folder (with the secret) is gone");
  assert.ok(f.calls.some((c) => c[0] === "compose" && c.includes("down") && c.includes("-v")));
  assert.equal(f.live.size, 0);
  assert.ok(f.calls.some((c) => c[0] === "volume" && c[1] === "ls"));
  assert.ok(f.calls.some((c) => c[0] === "network" && c[1] === "ls"));
});

test("a failing scenario is cleaned up, its logs are captured redacted and written, and the error is redacted", async () => {
  const logDir = path.join(tmp, "logs");
  let secret = "";
  const f = fakeDocker({ logs: "boot ok" });
  const docker = async (args: string[]) => {
    const r = await f.docker(args);
    return args.includes("logs") ? { ...r, stdout: `line ${secret} line` } : r;
  };
  const printed: string[] = [];
  const scenario: Scenario = async (ctx) => {
    secret = ctx.authSecret;
    throw new Error(`boom ${ctx.authSecret}`);
  };
  await assert.rejects(runSmoke(baseDeps(docker, { logDir, log: (l: string) => printed.push(l) }), scenario), (e: Error) => {
    assert.match(e.message, /boom \[redacted\]/);
    assert.ok(!e.message.includes(secret));
    return true;
  });
  assert.ok(f.calls.some((c) => c.includes("down")), "down -v ran after the failure");
  assert.equal(f.live.size, 0);
  assert.ok(!printed.join("\n").includes(secret), "nothing printed contains the secret");
  const files = readdirSync(logDir);
  assert.ok(files.includes("failure-app.log") && files.includes("failure-proxy.log"));
  for (const file of files) assert.ok(!readFileSync(path.join(logDir, file), "utf8").includes(secret), `${file} is redacted`);
});

test("a PASSING scenario whose service log contains the secret fails the run, while printed output and the log folder stay redacted", async () => {
  const logDir = path.join(tmp, "logs-leak");
  let secret = "";
  const f = fakeDocker();
  const docker = async (args: string[]) => {
    const r = await f.docker(args);
    return args.includes("logs") ? { ...r, stdout: `startup line\nAUTH_SECRET leaked: ${secret}\nend` } : r;
  };
  const printed: string[] = [];
  await assert.rejects(
    runSmoke(baseDeps(docker, { logDir, log: (l: string) => printed.push(l) }), async (ctx) => {
      secret = ctx.authSecret;
      await captureLogs(ctx, "default"); // what the real scenario does after each phase; nothing throws
    }),
    (e: Error) => {
      assert.match(e.message, /AUTH_SECRET appeared in a docker argument, output or service log/);
      assert.ok(!e.message.includes(secret));
      return true;
    },
  );
  assert.ok(!printed.join("\n").includes(secret), "console output is redacted");
  assert.ok(printed.join("\n").includes("[redacted]"), "the failure print shows the logs, redacted");
  const files = readdirSync(logDir);
  assert.ok(files.includes("default-app.log"));
  for (const file of files) {
    const text = readFileSync(path.join(logDir, file), "utf8");
    assert.ok(!text.includes(secret), `${file} is redacted`);
    assert.ok(text.includes("[redacted]"));
  }
  assert.equal(f.live.size, 0, "cleanup still ran");
});

test("cleanup that cannot remove everything fails the run, and a secret in any docker argument fails it too", async () => {
  const stuck = fakeDocker({ leftoverAfterRemoval: true });
  await assert.rejects(runSmoke(baseDeps(stuck.docker), async () => undefined), /remain after cleanup/);
  const f = fakeDocker();
  await assert.rejects(
    runSmoke(baseDeps(f.docker), async (ctx) => {
      await ctx.docker(["echo", ctx.authSecret]);
    }),
    /AUTH_SECRET appeared/,
  );
  await assert.rejects(runSmoke(baseDeps(f.docker, { env: { STYLE_DOMAIN: "x" } }), async () => undefined), /STYLE_DOMAIN/);
});

test("a sensitive docker output (compose config) is not part of the leak scan, but a failing command is reported", async () => {
  const f = fakeDocker();
  let secret = "";
  const docker = async (args: string[]) => (args.includes("config") ? { code: 0, stdout: `AUTH_SECRET=${secret}`, stderr: "" } : f.docker(args));
  await runSmoke(baseDeps(docker), async (ctx) => {
    secret = ctx.authSecret;
    await ctx.docker(["compose", "config"], { sensitive: true });
  });
  const failing = async (args: string[]) => (args[0] === "image" ? { code: 1, stdout: "", stderr: "No such image" } : f.docker(args));
  await assert.rejects(runSmoke(baseDeps(failing), async (ctx) => void (await ctx.docker(["image", "inspect", "x"]))), /docker image failed.*No such image/);
});

test("--cleanup-only fails when a removal fails, and still reports what it did remove", async () => {
  const f = fakeDocker();
  const lines: string[] = [];
  const docker = async (args: string[]) => (args[0] === "rm" && args.at(-1) === "c2" ? { code: 1, stdout: "", stderr: "in use" } : f.docker(args));
  await assert.rejects(cleanupAll(docker, (l) => lines.push(l)), /could not remove: c2/);
  assert.match(lines[0], /removed 1/);
});

test("--cleanup-only removes every smoke container, volume and network by name and reports the count", async () => {
  const f = fakeDocker();
  const lines: string[] = [];
  const removed = await cleanupAll(f.docker, (l) => lines.push(l));
  assert.equal(removed, 2);
  assert.match(lines[0], /removed 2/);
  assert.ok(f.calls.every((c) => !c.includes("down")), "no compose project is needed to sweep");
});

// --- wiring: workflow, package script, docs ---------------------------------------------------

test("the workflow runs the smoke test in the docker job after the build-022 drill, with a timeout, log capture and an always-sweep", () => {
  const ci = read(".github/workflows/ci.yml");
  const order = ["docker build -t style-studio:ci .", "scripts/ci-backup-drill.ts", "scripts/ci-compose-smoke.ts", "scripts/ci-compose-smoke.ts --cleanup-only", "Container logs"].map((s) => ci.indexOf(s));
  assert.ok(order.every((i) => i >= 0), "all steps exist");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "steps are in order");
  const step = /- name: Compose \+ Caddy smoke test[\s\S]*?(?=\n      - name:)/.exec(ci)?.[0] ?? "";
  assert.match(step, /timeout-minutes: 15/);
  assert.match(step, /IMAGE: style-studio:ci/);
  assert.match(step, /SMOKE_LOG_DIR: \$\{\{ runner\.temp \}\}\/compose-smoke-logs/);
  assert.match(step, /run: npx tsx scripts\/ci-compose-smoke\.ts$/m);
  assert.doesNotMatch(step, /OLLAMA|SMTP|AUTH_SECRET/, "no real model, mail or secret is configured in the workflow");
  assert.match(ci, /- name: Compose smoke cleanup sweep\n\s+if: always\(\)\n\s+run: npx tsx scripts\/ci-compose-smoke\.ts --cleanup-only/);
  assert.match(ci, /upload-artifact@v4[\s\S]*?if: always\(\)|if: always\(\)[\s\S]*?upload-artifact@v4/);
  assert.match(ci, /compose-smoke-logs/);
  assert.equal(JSON.parse(read("package.json")).scripts["ci:compose-smoke"], "tsx scripts/ci-compose-smoke.ts");
});

test("the smoke test never touches production files or the shipped image definition, and the notes and guide say what it is and is not", () => {
  const source = read("scripts/ci-compose-smoke.ts");
  assert.doesNotMatch(source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""), /writeFileSync\([^)]*(compose\.yaml|Caddyfile)/, "shipped files are copied, never written");
  assert.doesNotMatch(source, /ollama\/ollama|pull\b.*qwen|SMTP_URL=smtp:\/\/(?!127\.0\.0\.1)/);
  assert.ok(existsSync(path.join(process.cwd(), "docs/reviews/implementation-023-notes.md")));
  const notes = read("docs/reviews/implementation-023-notes.md");
  const guide = read("docs/DEPLOYMENT.md");
  for (const text of [notes, guide]) {
    assert.match(text, /build 023/i);
    assert.match(text, /not (yet )?(been )?run|NOT RUN|until the first/i);
    assert.match(text, /public (domain|certificate)/i);
  }
  assert.match(guide, /### Compose \+ Caddy smoke test \(build 023;/);
  assert.doesNotMatch(guide, /Compose 2\.24/, "the operator guide names no Compose version (tests/proxyConfig.test.ts)");
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
