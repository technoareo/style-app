import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { findSecret, redact } from "./ci-backup-drill-plan";
import { realDocker, type Docker, type DockerResult } from "./ci-backup-drill";
import {
  CADDY_SERVERS_COMMAND,
  CA_PATH_IN_PROXY,
  DEFAULT_BODY_MS,
  DIRECT_PROBE_SOURCE,
  LOCK_HOLDER_SOURCE,
  LOCK_READY_MARKER,
  PROC_ENV_SOURCE,
  PROXY_ENV_COMMAND,
  REFUSAL,
  SMOKE_APP_URL,
  SMOKE_DOMAIN,
  SMOKE_HTTPS_PORT,
  SMOKE_HTTP_PORT,
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
  headerMap,
  listByNameArgs,
  logsArgs,
  makeRunId,
  projectEnvFile,
  proxyCapSeconds,
  psArgs,
  runNoDepsArgs,
  securityHeaderProblems,
  smokeNames,
  stalledWindowMs,
  unexpectedDiffs,
  upArgs,
  type SmokeNames,
} from "./ci-compose-smoke-plan";

/**
 * Build 023: Docker Compose + Caddy smoke test for GitHub's Ubuntu/Docker job.
 *
 *   npx tsx scripts/ci-compose-smoke.ts                 run it
 *   npx tsx scripts/ci-compose-smoke.ts --cleanup-only  remove anything a run left (by name)
 *
 *   IMAGE (default style-studio:ci)   SMOKE_LOG_DIR (optional: write redacted service logs there)
 *
 * It copies the SHIPPED compose.yaml and deploy/Caddyfile into a throw-away
 * project folder, adds deploy/ci/compose.smoke.yaml (image, mock model, loopback
 * ports) and the two generated env files, and then drives real `docker compose`:
 *
 *  1. The override changes only the allow-listed paths (config compared with and
 *     without it); the project variable reaches app and proxy as the same value.
 *  2. DEFAULT 20000: `up app proxy` (waits for the app healthcheck). The app
 *     process really has STYLE_BODY_READ_TIMEOUT_MS=20000, the proxy's PID 1 has
 *     the derived 22, and Caddy's running config shows 22 s, 10 s and HTTP/1.1.
 *     Through local-CA TLS: ALPN picks http/1.1 although h2 is offered, health
 *     keeps its connection alive, HTTP redirects to HTTPS, the five security
 *     headers are present once, /api/health/uploads is 404 (and its variants
 *     are not served) while the app answers it directly. A direct app answer
 *     and the proxied one are compared for 401, 403, 404, 413 and a 503 with
 *     Retry-After (a held database write lock). A stalled upload gets the app's
 *     own 408 before the proxy cap, then the connection closes.
 *  3. RAISED 30000: recreate, same proofs (32 s, stalled upload at 30 s).
 *  4. FAIL CLOSED: invalid values (and a stale .env.production value, and an
 *     empty domain) make the shipped start commands exit 1 with their message;
 *     through `up`, the proxy never starts when the app refuses.
 *  Finally the project is removed (`down -v`), then anything left by name is
 *  removed and the run fails if something remains.
 *
 * No model, no SMTP delivery, no public domain or certificate, no external
 * account. The Caddy certificate comes from Caddy's own internal CA.
 */

export type DockerOptions = { input?: string; timeoutMs?: number; allowFail?: boolean };
type CtxDockerOptions = DockerOptions & { sensitive?: boolean };

export type HttpSpec = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Plain HTTP on the redirect port instead of TLS. */
  plain?: boolean;
  keepAlive?: boolean;
  timeoutMs?: number;
};
export type HttpResult = {
  status: number;
  rawHeaders: string[];
  body: string;
  reusedSocket: boolean;
  alpn: string | false | null;
  /** The HTTP version the SERVER answered with (res.httpVersion), e.g. "1.1". */
  httpVersion: string;
  elapsedMs: number;
};
export type StalledResult = HttpResult & { closedAfterMs: number | null };
export interface Http {
  request(spec: HttpSpec): Promise<HttpResult>;
  alpn(offered: string[]): Promise<string | false | null>;
  stalledUpload(o: { path: string; declaredLength: number; timeoutMs: number }): Promise<StalledResult>;
  close(): void;
}

export type DockerStart = (
  args: string[],
  readyMarker: string,
  timeoutMs?: number,
) => { ready: Promise<void>; done: Promise<DockerResult> };

export type SmokeDeps = {
  docker: Docker;
  start?: DockerStart;
  makeHttp?: (ca: string) => Http;
  log?: (line: string) => void;
  random?: (n: number) => Buffer;
  image?: string;
  repoRoot?: string;
  tmpRoot?: string;
  logDir?: string;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
};

export type SmokeContext = {
  deps: SmokeDeps;
  names: SmokeNames;
  image: string;
  dir: string;
  authSecret: string;
  secrets: string[];
  argvLog: string[][];
  outputs: string[];
  /** RAW service logs, kept so the secret scan can see them. Redact before printing or writing (printLogs, writeLogs). */
  logs: Map<string, string>;
  http: Http | null;
  step: (label: string) => void;
  ok: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  docker: (args: string[], options?: CtxDockerOptions) => Promise<DockerResult>;
};

export type Scenario = (ctx: SmokeContext) => Promise<void>;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- real docker streaming and real HTTP ----------------------------------------------

export function realStart(): DockerStart {
  return (args, marker, timeoutMs = 30_000) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let markerSeen = false;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (e: Error) => void = () => undefined;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    const timer = setTimeout(() => rejectReady(new Error("The lock holder did not report ready in time.")), timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (!markerSeen && stdout.includes(marker)) {
        markerSeen = true;
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.stderr.on("data", (d) => (stderr += String(d)));
    const done = new Promise<DockerResult>((resolve) => {
      child.on("close", (code) => {
        clearTimeout(timer);
        if (!markerSeen) rejectReady(new Error(`The lock holder exited before it held the lock: ${stderr.trim().slice(-300)}`));
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
    ready.catch(() => undefined);
    return { ready, done };
  };
}

export function realHttp(o: {
  host?: string;
  domain: string;
  httpPort: number;
  httpsPort: number;
  ca?: string;
  /** "http" only in tests, to exercise this code against a plain local server. */
  scheme?: "https" | "http";
}): Http {
  const host = o.host ?? "127.0.0.1";
  const secure = (o.scheme ?? "https") === "https";
  const keepAliveAgent: http.Agent = secure
    ? new https.Agent({ keepAlive: true, maxSockets: 1, ca: o.ca })
    : new http.Agent({ keepAlive: true, maxSockets: 1 });
  const target = (plain?: boolean) => {
    const useTls = secure && !plain;
    const port = plain ? o.httpPort : o.httpsPort;
    return {
      module: (useTls ? https : http) as typeof http,
      port,
      tlsOptions: useTls ? { servername: o.domain, ca: o.ca } : {},
      hostHeader: `${o.domain}:${port}`,
    };
  };

  return {
    request(spec) {
      return new Promise((resolve, reject) => {
        const t = target(spec.plain);
        const start = Date.now();
        const body = spec.body === undefined ? null : Buffer.from(spec.body);
        const req = t.module.request(
          {
            host,
            port: t.port,
            method: spec.method,
            path: spec.path,
            headers: { host: t.hostHeader, ...(spec.headers ?? {}), ...(body ? { "content-length": String(body.length) } : {}) },
            agent: spec.keepAlive ? keepAliveAgent : false,
            ...t.tlsOptions,
          },
          (res) => {
            const alpn = (res.socket as tls.TLSSocket | null)?.alpnProtocol ?? null;
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                rawHeaders: res.rawHeaders,
                body: Buffer.concat(chunks).toString("utf8"),
                reusedSocket: req.reusedSocket,
                alpn,
                httpVersion: res.httpVersion,
                elapsedMs: Date.now() - start,
              }),
            );
          },
        );
        req.setTimeout(spec.timeoutMs ?? 15_000, () => req.destroy(new Error(`${spec.method} ${spec.path} timed out`)));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    },

    alpn(offered) {
      return new Promise((resolve, reject) => {
        if (!secure) return resolve(null);
        const socket = tls.connect(
          { host, port: o.httpsPort, servername: o.domain, ca: o.ca, ALPNProtocols: offered },
          () => {
            const negotiated = socket.alpnProtocol;
            socket.end();
            resolve(negotiated);
          },
        );
        socket.on("error", reject);
      });
    },

    stalledUpload({ path: p, declaredLength, timeoutMs }) {
      return new Promise((resolve, reject) => {
        const t = target(false);
        const start = Date.now();
        let responded = false;
        let closedAt: number | null = null;
        const fail = setTimeout(() => {
          if (!responded) {
            req.destroy();
            reject(new Error(`No answer to the stalled upload within ${Math.round(timeoutMs / 1000)} s (the proxy cut it silently).`));
          }
        }, timeoutMs);
        const req = t.module.request(
          {
            host,
            port: t.port,
            method: "POST",
            path: p,
            headers: { host: t.hostHeader, "content-type": "application/json", "content-length": String(declaredLength) },
            agent: false,
            ...t.tlsOptions,
          },
          (res) => {
            responded = true;
            clearTimeout(fail);
            const at = Date.now() - start;
            const alpn = (res.socket as tls.TLSSocket | null)?.alpnProtocol ?? null;
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", async () => {
              // Give the proxy a moment to close the connection it said it would close.
              for (let waited = 0; closedAt === null && waited < 3000; waited += 50) await realSleep(50);
              resolve({
                status: res.statusCode ?? 0,
                rawHeaders: res.rawHeaders,
                body: Buffer.concat(chunks).toString("utf8"),
                reusedSocket: false,
                alpn,
                httpVersion: res.httpVersion,
                elapsedMs: at,
                closedAfterMs: closedAt,
              });
            });
          },
        );
        req.on("socket", (s) => s.once("close", () => (closedAt = Date.now() - start)));
        req.on("error", (e) => {
          if (!responded) {
            clearTimeout(fail);
            reject(e);
          }
        });
        req.write('{"email":');
        // never ended: the body stalls
      });
    },

    close() {
      keepAliveAgent.destroy();
    },
  };
}

// --- orchestration --------------------------------------------------------------------

/** Run the smoke test; always clean up; throw the first failure (after cleanup). */
export async function runSmoke(deps: SmokeDeps, scenario: Scenario = realScenario): Promise<void> {
  const names = smokeNames(makeRunId(deps.random));
  const authSecret = generateAuthSecret(deps.random);
  const secrets = [authSecret];
  const log = deps.log ?? ((line: string) => console.log(line));
  assertCleanEnvironment(deps.env ?? process.env);
  const dir = mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), "style-smoke-"));
  chmodSync(dir, 0o700);
  const argvLog: string[][] = [];
  const outputs: string[] = [];
  let currentStep = "start";
  const ctx: SmokeContext = {
    deps,
    names,
    image: deps.image ?? "style-studio:ci",
    dir,
    authSecret,
    secrets,
    argvLog,
    outputs,
    logs: new Map(),
    http: null,
    step: (label) => {
      currentStep = label;
      log(`[smoke ${names.runId}] ${label}`);
    },
    ok: (line) => log(`[smoke ${names.runId}]   ok: ${line}`),
    sleep: deps.sleep ?? realSleep,
    docker: async (args, options = {}) => {
      argvLog.push(args);
      const { sensitive, ...rest } = options;
      const result = await deps.docker(args, rest);
      if (!sensitive) outputs.push(result.stdout, result.stderr);
      if (result.code !== 0 && !options.allowFail)
        throw new Error(
          `docker ${args[0]} failed during "${currentStep}" (exit ${result.code}): ${redact(result.stderr, secrets).trim().slice(-400)}`,
        );
      return result;
    },
  };

  let failure: unknown;
  try {
    prepareProject(ctx);
    await scenario(ctx);
    const leaked = findSecret(secrets, [...argvLog.map((a) => a.join(" ")), ...outputs, ...ctx.logs.values()]);
    expect(leaked === undefined, "AUTH_SECRET appeared in a docker argument, output or service log.");
  } catch (error) {
    failure = error;
    await captureLogs(ctx, "failure").catch(() => undefined);
    for (const [label, text] of ctx.logs) log(`--- ${label} (last lines) ---\n${redact(text.split("\n").slice(-40).join("\n"), secrets)}`);
  }
  try {
    writeLogs(ctx);
  } catch {
    // log files are best effort
  }
  ctx.http?.close();
  try {
    await cleanup(ctx);
  } catch (error) {
    failure ??= error;
    log(`[smoke ${names.runId}] CLEANUP FAILED: ${redact(String((error as Error).message), secrets)}`);
  }
  if (failure) throw new Error(redact(failure instanceof Error ? failure.message : "The smoke test failed.", secrets));
  log(`[smoke ${names.runId}] PASSED and cleaned up.`);
}

/** The throw-away project folder: shipped files copied byte for byte, plus the CI override and generated env files. */
export function prepareProject(ctx: SmokeContext): void {
  const root = ctx.deps.repoRoot ?? process.cwd();
  const copies: [string, string][] = [
    ["compose.yaml", "compose.yaml"],
    ["deploy/Caddyfile", "deploy/Caddyfile"],
    ["deploy/ci/mock-ollama.mjs", "deploy/ci/mock-ollama.mjs"],
    ["deploy/ci/compose.smoke.yaml", "compose.smoke.yaml"],
  ];
  mkdirSync(path.join(ctx.dir, "deploy", "ci"), { recursive: true });
  for (const [from, to] of copies) {
    copyFileSync(path.join(root, from), path.join(ctx.dir, to));
    expect(sha(path.join(root, from)) === sha(path.join(ctx.dir, to)), `${from} was not copied unchanged.`);
  }
  writeProjectEnv(ctx, {});
  writeAppEnv(ctx, []);
}

export const writeProjectEnv = (ctx: SmokeContext, o: { domain?: string | null; bodyTimeout?: string | null }): void =>
  writeFileSync(path.join(ctx.dir, ".env"), projectEnvFile(o), { mode: 0o600 });
export const writeAppEnv = (ctx: SmokeContext, extraLines: string[]): void =>
  writeFileSync(path.join(ctx.dir, ".env.production"), appEnvFile({ authSecret: ctx.authSecret, extraLines }), { mode: 0o600 });

const SERVICES = ["app", "proxy", "ollama"] as const;

/** Tail of each service's log, kept RAW for the secret scan; printing and the log folder redact it. */
export async function captureLogs(ctx: SmokeContext, label: string): Promise<void> {
  for (const service of SERVICES) {
    const r = await ctx.deps.docker(logsArgs(ctx.names.project, ctx.dir, service, 200), {});
    const text = `${r.stdout}${r.stderr}`.trim();
    if (text) ctx.logs.set(`${label}-${service}`, text);
  }
}

function writeLogs(ctx: SmokeContext): void {
  const dir = ctx.deps.logDir;
  if (!dir || ctx.logs.size === 0) return;
  mkdirSync(dir, { recursive: true });
  for (const [label, text] of ctx.logs) writeFileSync(path.join(dir, `${label}.log`), `${redact(text, ctx.secrets)}\n`, { mode: 0o600 });
}

const ids = (r: DockerResult) => r.stdout.split(/\s+/).filter(Boolean);

async function cleanup(ctx: SmokeContext): Promise<void> {
  const { docker } = ctx.deps;
  const run = ctx.names;
  await docker(downArgs(run.project, ctx.dir), {});
  for (const id of ids(await docker(listByNameArgs("container", run)))) await docker(["rm", "-f", "-v", id]);
  for (const volume of ids(await docker(listByNameArgs("volume", run)))) await docker(["volume", "rm", "-f", volume]);
  for (const network of ids(await docker(listByNameArgs("network", run)))) await docker(["network", "rm", network]);
  rmSync(ctx.dir, { recursive: true, force: true });
  const left = [
    ...ids(await docker(listByNameArgs("container", run))),
    ...ids(await docker(listByNameArgs("volume", run))),
    ...ids(await docker(listByNameArgs("network", run))),
  ];
  expect(left.length === 0, "Smoke containers, volumes or networks remain after cleanup.");
}

/** `--cleanup-only`: remove everything any smoke run named (for an `if: always()` workflow step). */
export async function cleanupAll(docker: Docker, log: (line: string) => void = console.log): Promise<number> {
  let removed = 0;
  const failed: string[] = [];
  const remove = async (args: string[], id: string) => {
    const r = await docker(args);
    if (r.code === 0) removed++;
    else failed.push(id);
  };
  for (const id of ids(await docker(listByNameArgs("container")))) await remove(["rm", "-f", "-v", id], id);
  for (const volume of ids(await docker(listByNameArgs("volume")))) await remove(["volume", "rm", "-f", volume], volume);
  for (const network of ids(await docker(listByNameArgs("network")))) await remove(["network", "rm", network], network);
  log(`Smoke cleanup removed ${removed} leftover resource(s).`);
  if (failed.length) throw new Error(`Smoke cleanup could not remove: ${failed.join(", ")}`);
  return removed;
}

// --- the real scenario -----------------------------------------------------------------

const lastJson = <T>(text: string): T => JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as T;

type Direct = { status: number; rawHeaders: string[]; body: string };

/** `docker compose ps -a --format json` is one array in some versions and one object per line in others. */
export function parsePs(text: string): { Service: string; State: string; ExitCode: number; Health?: string }[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed) as unknown;
    return (Array.isArray(whole) ? whole : [whole]) as ReturnType<typeof parsePs>;
  } catch {
    return trimmed.split("\n").map((l) => JSON.parse(l)) as ReturnType<typeof parsePs>;
  }
}

async function realScenario(ctx: SmokeContext): Promise<void> {
  const { names, dir } = ctx;
  const project = names.project;
  const exec = (service: string, command: string[], options?: CtxDockerOptions) =>
    ctx.docker(execArgs(project, dir, service, command), options);
  const http = () => {
    expect(ctx.http, "the HTTP client is not ready");
    return ctx.http;
  };
  const down = () => ctx.docker(downArgs(project, dir));

  const direct = async (spec: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Direct> =>
    lastJson<Direct>(
      (
        await exec("app", [
          "node",
          "-e",
          DIRECT_PROBE_SOURCE,
          spec.method,
          spec.path,
          JSON.stringify(spec.headers ?? {}),
          spec.body === undefined ? "" : Buffer.from(spec.body).toString("base64"),
        ])
      ).stdout,
    );

  async function until<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const value = await probe();
        if (value !== undefined) return value;
      } catch {
        // not ready yet
      }
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}.`);
      await ctx.sleep(1000);
    }
  }

  // 0. Preflight ------------------------------------------------------------------
  ctx.step("preflight: Docker Compose version and the CI image");
  const version = await ctx.docker(["compose", "version"]);
  expect(composeSupportsOverride(version.stdout), `Docker Compose 2.24 or newer is needed for compose.smoke.yaml; found: ${version.stdout.trim()}`);
  await ctx.docker(["image", "inspect", ctx.image, "--format", "{{.Id}}"]);

  // 1. The override changes only what it says -----------------------------------------
  ctx.step("compose.smoke.yaml changes only the allow-listed settings; the shipped values reach app and proxy");
  type Config = { services: Record<string, Record<string, any>> };
  const merged = JSON.parse((await ctx.docker(configArgs(project, dir, true), { sensitive: true })).stdout) as Config;
  const shipped = JSON.parse((await ctx.docker(configArgs(project, dir, false), { sensitive: true })).stdout) as Config;
  const unexpected = unexpectedDiffs(diffPaths(shipped, merged));
  expect(unexpected.length === 0, `compose.smoke.yaml changed settings it must not: ${unexpected.join(", ")}`);
  ctx.ok("only image, pull policy, restart, proxy ports and the mock model differ from the shipped compose.yaml");
  const s = merged.services;
  expect(s.app.environment.STYLE_COMPOSE_BODY_READ_TIMEOUT_MS === String(DEFAULT_BODY_MS), "app did not receive the default 20000");
  expect(s.proxy.environment.STYLE_COMPOSE_BODY_READ_TIMEOUT_MS === String(DEFAULT_BODY_MS), "proxy did not receive the default 20000");
  expect(s.proxy.environment.STYLE_DOMAIN === SMOKE_DOMAIN, "proxy did not receive STYLE_DOMAIN from the project .env");
  expect(!s.proxy.env_file, "the proxy must not load .env.production");
  expect(!s.app.ports, "the app must publish no port");
  const published = (s.proxy.ports as { published: string | number; target: number; host_ip?: string }[])
    .map((p) => `${p.host_ip ?? ""}:${p.published}->${p.target}`)
    .sort();
  expect(
    JSON.stringify(published) === JSON.stringify([`127.0.0.1:${SMOKE_HTTPS_PORT}->443`, `127.0.0.1:${SMOKE_HTTP_PORT}->80`].sort()),
    `unexpected proxy ports: ${published.join(", ")}`,
  );
  expect(String(s.proxy.command?.at?.(-1) ?? "").includes("exec caddy run --config /etc/caddy/Caddyfile"), "the proxy command is not the shipped one");
  writeProjectEnv(ctx, { bodyTimeout: "" });
  const emptyValue = JSON.parse((await ctx.docker(configArgs(project, dir, true), { sensitive: true })).stdout) as Config;
  expect(
    emptyValue.services.app.environment.STYLE_COMPOSE_BODY_READ_TIMEOUT_MS === String(DEFAULT_BODY_MS),
    "an empty STYLE_BODY_READ_TIMEOUT_MS= line must fall back to 20000",
  );
  ctx.ok("an empty project value falls back to 20000 (documented: it is not an error)");
  writeProjectEnv(ctx, {});

  // Shared proofs for a running stack ---------------------------------------------------
  async function startStack(): Promise<void> {
    await ctx.docker(upArgs(project, dir), { timeoutMs: 300_000 });
    const ps = parsePs((await ctx.docker(psArgs(project, dir))).stdout);
    const state = (service: string) => ps.find((p) => p.Service === service);
    expect(state("app")?.State === "running" && state("app")?.Health === "healthy", "the app is not running and healthy");
    expect(state("proxy")?.State === "running", "the proxy is not running");
    expect(!state("worker") && !state("mailer"), "worker or mailer started; the smoke test must not start them");
    const ca = await until("Caddy's local CA", 90_000, async () => {
      const r = await exec("proxy", ["cat", CA_PATH_IN_PROXY], { allowFail: true });
      return r.code === 0 && r.stdout.includes("BEGIN CERTIFICATE") ? r.stdout : undefined;
    });
    ctx.http?.close();
    ctx.http = (ctx.deps.makeHttp ?? ((pem) => realHttp({ domain: SMOKE_DOMAIN, httpPort: SMOKE_HTTP_PORT, httpsPort: SMOKE_HTTPS_PORT, ca: pem })))(ca);
    await until("a healthy answer through the proxy", 90_000, async () => {
      const r = await http().request({ method: "GET", path: "/api/health" });
      return r.status === 200 ? r : undefined;
    });
  }

  async function proveTimeoutWiring(appMs: number): Promise<void> {
    const proc = lastJson<{ found: number; value: string | null }>(
      (await exec("app", ["node", "-e", PROC_ENV_SOURCE, "STYLE_BODY_READ_TIMEOUT_MS", "server.js"])).stdout,
    );
    expect(proc.found === 1 && proc.value === String(appMs), `the running server has STYLE_BODY_READ_TIMEOUT_MS=${proc.value} (found ${proc.found}), expected ${appMs}`);
    ctx.ok(`the running app process has STYLE_BODY_READ_TIMEOUT_MS=${appMs}`);
    const proxyEnv = new Map(
      (await exec("proxy", PROXY_ENV_COMMAND)).stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
    );
    expect(proxyEnv.get("STYLE_COMPOSE_BODY_READ_TIMEOUT_MS") === String(appMs), "the proxy received a different value than the app");
    expect(proxyEnv.get("STYLE_PROXY_BODY_READ_TIMEOUT_S") === String(proxyCapSeconds(appMs)), `the proxy derived ${proxyEnv.get("STYLE_PROXY_BODY_READ_TIMEOUT_S")} s, expected ${proxyCapSeconds(appMs)} s`);
    ctx.ok(`the proxy derived ${proxyCapSeconds(appMs)} s from ${appMs} ms (ceil(ms/1000)+2)`);
    const { facts, raw } = caddyTimeoutFacts(JSON.parse((await exec("proxy", CADDY_SERVERS_COMMAND)).stdout));
    const problems = caddyTimeoutProblems(facts, appMs);
    expect(problems.length === 0, `Caddy's running configuration: ${problems.join("; ")} (timeouts: ${JSON.stringify(raw)})`);
    ctx.ok(`Caddy's running config: ${JSON.stringify(raw)}`);
  }

  async function proveStalledUpload(appMs: number): Promise<void> {
    const window = stalledWindowMs(appMs);
    const cap = proxyCapSeconds(appMs) * 1000;
    const r = await http().stalledUpload({ path: "/api/auth/sign-in/email", declaredLength: 2000, timeoutMs: cap + 15_000 });
    expect(r.status === 408, `a stalled upload got ${r.status}, expected the app's 408`);
    expect(/took too long/.test(r.body), "the 408 was not the application's own message");
    expect(r.elapsedMs >= window.min && r.elapsedMs <= window.max, `the 408 arrived after ${r.elapsedMs} ms; expected ${window.min}..${window.max} ms (app ${appMs} ms, proxy cap ${cap} ms)`);
    expect(headerMap(r.rawHeaders).get("connection")?.join(",").toLowerCase().includes("close"), "the 408 did not say Connection: close");
    expect(r.closedAfterMs !== null && r.closedAfterMs - r.elapsedMs < 3000, "the connection was not closed after the 408");
    ctx.ok(`stalled upload: the app's own 408 after ${r.elapsedMs} ms (proxy cap ${cap} ms), connection closed after ${r.closedAfterMs} ms`);
  }

  // 2. DEFAULT value, full routing proofs -------------------------------------------------
  ctx.step("start app and proxy with the default body timeout (20000)");
  await startStack();
  ctx.step("default value reaches the app process, the proxy and Caddy's running configuration");
  await proveTimeoutWiring(DEFAULT_BODY_MS);

  ctx.step("HTTP/1.1 policy, keep-alive health, redirect and security headers through the proxy");
  const offered = await http().alpn(["h2", "http/1.1"]);
  expect(offered === "http/1.1", `ALPN chose ${String(offered)} when h2 and http/1.1 were offered`);
  ctx.ok("ALPN: http/1.1 although h2 was offered; the answers themselves are HTTP/1.1");
  const health1 = await http().request({ method: "GET", path: "/api/health", keepAlive: true });
  const health2 = await http().request({ method: "GET", path: "/api/health", keepAlive: true });
  for (const h of [health1, health2]) {
    expect(h.httpVersion === "1.1" && h.alpn === "http/1.1", `health was answered with HTTP/${h.httpVersion} (ALPN ${String(h.alpn)}), expected HTTP/1.1`);
    expect(h.status === 200 && JSON.parse(h.body).ready === true, "health through the proxy was not ready");
    const hm = headerMap(h.rawHeaders);
    expect(hm.get("cache-control")?.join() === "no-store", "health lost Cache-Control: no-store");
    expect(!hm.has("alt-svc"), "an Alt-Svc header advertises another protocol");
  }
  expect(health2.reusedSocket, "the second health request did not reuse the connection");
  const healthDirect = await direct({ method: "GET", path: "/api/health" });
  const healthProblems = compareHeaders(healthDirect.rawHeaders, health1.rawHeaders, { expectClose: false });
  expect(healthProblems.length === 0, `health headers: ${healthProblems.join("; ")}`);
  ctx.ok("health: 200 twice on one kept-alive connection, headers match the app's plus the shipped security headers");
  const plain = await http().request({ method: "GET", path: "/api/health", plain: true });
  expect(plain.status >= 300 && plain.status < 400, `plain HTTP answered ${plain.status}, expected a redirect`);
  expect(new RegExp(`^https://${SMOKE_DOMAIN.replace(/\./g, "\\.")}(:\\d+)?/api/health$`).test(headerMap(plain.rawHeaders).get("location")?.[0] ?? ""), "the redirect does not point at the HTTPS site");
  ctx.ok(`plain HTTP redirects (${plain.status}) to the HTTPS site`);

  ctx.step("the operator-only upload counters are hidden by the proxy and still served by the app");
  const counters = await direct({ method: "GET", path: "/api/health/uploads" });
  expect(counters.status === 200 && "images" in JSON.parse(counters.body), "the app's own counters route did not answer directly");
  for (const p of ["/api/health/uploads", "/api/health/uploads/", "/api/health/uploads/x", "/api/health/uploads?x=1"]) {
    const r = await http().request({ method: "GET", path: p });
    expect(r.status === 404, `${p} answered ${r.status} through the proxy, expected 404`);
  }
  for (const p of ["/API/health/uploads", "/api/health/%75ploads", "//api/health/uploads"]) {
    const r = await http().request({ method: "GET", path: p });
    expect(r.status !== 200 && !r.body.includes("accountsHoldingUpload"), `${p} exposed the counters (status ${r.status})`);
  }
  ctx.ok("/api/health/uploads (and slash, sub-path, query) is 404; case, percent-encoded and double-slash variants are not served");

  ctx.step("direct app answers versus proxied answers: status, body, headers, Connection: close");
  const oversized = `{"email":"a@example.test","password":"${"x".repeat(40_000)}"}`;
  const json = { "content-type": "application/json" };
  const cases: { label: string; spec: { method: string; path: string; headers?: Record<string, string>; body?: string }; status: number }[] = [
    { label: "401 wardrobe without a session", spec: { method: "GET", path: "/api/wardrobe" }, status: 401 },
    { label: "403 change without the app origin", spec: { method: "PUT", path: "/api/wardrobe", headers: json, body: "{}" }, status: 403 },
    { label: "404 unknown route", spec: { method: "GET", path: "/api/does-not-exist" }, status: 404 },
    { label: "413 oversized account request", spec: { method: "POST", path: "/api/auth/sign-in/email", headers: { ...json, origin: SMOKE_APP_URL }, body: oversized }, status: 413 },
  ];
  async function compareCase(label: string, spec: (typeof cases)[number]["spec"], status: number): Promise<{ d: Direct; p: HttpResult }> {
    const d = await direct(spec);
    const p = await http().request(spec);
    expect(d.status === status && p.status === status, `${label}: direct ${d.status}, proxied ${p.status}, expected ${status}`);
    expect(d.body === p.body, `${label}: the body changed through the proxy`);
    const problems = compareHeaders(d.rawHeaders, p.rawHeaders, { expectClose: true });
    expect(problems.length === 0, `${label}: ${problems.join("; ")}`);
    ctx.ok(`${label}: identical status, body and headers; proxy added only its own and closed the connection`);
    return { d, p };
  }
  for (const c of cases) await compareCase(c.label, c.spec, c.status);

  ctx.step("503 with Retry-After while the database write lock is held (direct versus proxied)");
  const start = ctx.deps.start ?? realStart();
  const holder = start(execArgs(project, dir, "app", ["node", "-e", LOCK_HOLDER_SOURCE, "8000"]), LOCK_READY_MARKER, 30_000);
  await holder.ready;
  try {
    const signUp = {
      method: "POST",
      path: "/api/auth/sign-up/email",
      headers: { ...json, origin: SMOKE_APP_URL },
      body: JSON.stringify({ email: `smoke-${names.runId}@example.test`, password: `Smoke-${names.runId}-password-1!`, name: "Smoke Test" }),
    };
    const { d, p } = await compareCase("503 busy with Retry-After", signUp, 503);
    expect(headerMap(d.rawHeaders).get("retry-after")?.join() === "5" && headerMap(p.rawHeaders).get("retry-after")?.join() === "5", "Retry-After: 5 did not reach the client unchanged");
    expect(JSON.parse(p.body).code === "busy", "the 503 was not the application's busy answer");
  } finally {
    await holder.done;
  }
  const afterLock = await http().request({ method: "GET", path: "/api/health" });
  expect(afterLock.status === 200, "the app did not recover after the lock was released");

  ctx.step("a stalled upload gets the app's own 408 before the proxy cap (default 20 s, takes about 20 s)");
  await proveStalledUpload(DEFAULT_BODY_MS);
  await captureLogs(ctx, "default");

  // 3. RAISED value --------------------------------------------------------------------------
  const RAISED = 30_000;
  ctx.step("raise the project variable to 30000, recreate app and proxy");
  writeProjectEnv(ctx, { bodyTimeout: String(RAISED) });
  await startStack();
  await proveTimeoutWiring(RAISED);
  const raisedHealth = await http().request({ method: "GET", path: "/api/health" });
  expect(raisedHealth.status === 200, "health failed after the value was raised");
  ctx.step("a stalled upload at the raised value (takes about 30 s)");
  await proveStalledUpload(RAISED);
  await captureLogs(ctx, "raised");
  ctx.http?.close();
  ctx.http = null;
  await down();

  // 4. FAIL CLOSED ------------------------------------------------------------------------------
  ctx.step("invalid values make the shipped start commands exit 1 (one-off containers, no dependencies)");
  for (const bad of ["abc", "0999", "999", "20000s", "1e4", "130000", "1234567"]) {
    expect(!bodyTimeoutAccepted(bad), `test value ${bad} should be invalid`);
    writeProjectEnv(ctx, { bodyTimeout: bad });
    for (const service of ["app", "proxy"]) {
      const r = await ctx.docker(runNoDepsArgs(project, dir, service), { allowFail: true, timeoutMs: 120_000 });
      expect(r.code === 1 && r.stderr.includes(REFUSAL.range), `${service} with STYLE_BODY_READ_TIMEOUT_MS=${bad}: exit ${r.code}, message ${r.stderr.includes(REFUSAL.range) ? "present" : "missing"}`);
      expect(!/Auth schema|serving initial configuration/.test(r.stdout + r.stderr), `${service} started despite ${bad}`);
    }
  }
  ctx.ok("abc, 0999, 999, 20000s, 1e4, 130000, 1234567 are refused by both app and proxy with exit 1 and the shipped message");
  writeProjectEnv(ctx, { domain: null });
  const noDomain = await ctx.docker(runNoDepsArgs(project, dir, "proxy"), { allowFail: true, timeoutMs: 120_000 });
  expect(noDomain.code === 1 && noDomain.stderr.includes(REFUSAL.domain), "the proxy started without STYLE_DOMAIN");
  ctx.ok("an empty STYLE_DOMAIN stops the proxy with its message");

  ctx.step("through `up`: an invalid value, and a stale .env.production value, stop everything (fail closed)");
  async function proveFailsClosed(label: string, message: string): Promise<void> {
    const up = await ctx.docker(upArgs(project, dir), { allowFail: true, timeoutMs: 300_000 });
    expect(up.code !== 0, `${label}: docker compose up succeeded`);
    const ps = parsePs((await ctx.docker(psArgs(project, dir))).stdout);
    const app = ps.find((p) => p.Service === "app");
    expect(app && app.State === "exited" && app.ExitCode === 1, `${label}: the app should have exited 1, found ${JSON.stringify(app)}`);
    expect(!ps.some((p) => p.Service === "proxy" && p.State === "running"), `${label}: the proxy is running although the app refused`);
    expect(!ps.some((p) => (p.Service === "worker" || p.Service === "mailer") && p.State === "running"), `${label}: worker or mailer is running`);
    const logs = await ctx.docker(logsArgs(project, dir, "app", 20), { allowFail: true });
    expect((logs.stdout + logs.stderr).includes(message), `${label}: the app log lacks "${message}"`);
    ctx.ok(`${label}: app exited 1 with its message; proxy, worker and mailer are not running`);
    await captureLogs(ctx, label.replace(/\W+/g, "-"));
    await down();
  }
  writeProjectEnv(ctx, { bodyTimeout: "abc" });
  await proveFailsClosed("invalid project value", REFUSAL.range);
  writeProjectEnv(ctx, {});
  writeAppEnv(ctx, ["STYLE_BODY_READ_TIMEOUT_MS=30000"]);
  await proveFailsClosed("stale .env.production value", REFUSAL.stale);
  writeAppEnv(ctx, []);
}

// --- command line -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const docker = realDocker();
  if (process.argv.includes("--cleanup-only")) {
    await cleanupAll(docker);
    return;
  }
  await runSmoke({ docker, image: process.env.IMAGE || "style-studio:ci", logDir: process.env.SMOKE_LOG_DIR || undefined });
}

if (process.argv[1] && /ci-compose-smoke\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error) => {
    console.error("Compose smoke test FAILED:", error instanceof Error ? error.message : "unexpected error");
    process.exit(1);
  });
}
