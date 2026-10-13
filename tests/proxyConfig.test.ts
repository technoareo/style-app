import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * STATIC TEXT CHECK ONLY. It reads deploy/Caddyfile, compose.yaml and
 * docs/DEPLOYMENT.md as text. It does NOT run Caddy or Docker, so it proves the
 * rule is written down and ordered correctly, not that a running proxy returns
 * 404. It exists so the default stays safe: /api/health/uploads (unauthenticated
 * counters) is not served by the public proxy, while the app route still exists
 * for operators on the internal address.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Body of the first `{ ... }` block whose header line matches `header`, or null. */
export function blockBody(text: string, header: RegExp): string | null {
  const m = header.exec(text);
  if (!m) return null;
  let depth = 1;
  const start = m.index + m[0].length;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i);
  }
  return null;
}

/** Everything wrong with a Caddyfile's handling of the upload-counter route. */
export function uploadCounterProblems(caddyfile: string): string[] {
  const problems: string[] = [];
  const matcher = /^\s*@([A-Za-z0-9_]+)\s+path\s+([^\n{]+)$/m.exec(caddyfile);
  if (!matcher) return ["no named path matcher for the upload counters"];
  const name = matcher[1];
  const paths = matcher[2].trim().split(/\s+/);
  if (!paths.includes("/api/health/uploads")) problems.push("matcher does not list /api/health/uploads");
  if (!paths.includes("/api/health/uploads/*")) problems.push("matcher does not list /api/health/uploads/*");

  const blocked = blockBody(caddyfile, new RegExp(`handle\\s+@${name}\\s*\\{`));
  if (blocked === null) return [...problems, `no \`handle @${name}\` block`];
  if (!/^\s*respond\s+404\s*$/m.test(blocked)) problems.push("the matcher block does not respond 404");
  if (/reverse_proxy/.test(blocked)) problems.push("the matcher block proxies to the app");

  const open = blockBody(caddyfile, /handle\s*\{/);
  if (open === null || !/^\s*reverse_proxy\s+app:3000\s*$/m.test(open))
    problems.push("no catch-all `handle { reverse_proxy app:3000 }`");
  if ((caddyfile.match(/reverse_proxy/g) ?? []).length !== 1)
    problems.push("reverse_proxy must appear exactly once, inside the catch-all handle");
  if (caddyfile.search(new RegExp(`handle\\s+@${name}\\s*\\{`)) > caddyfile.search(/handle\s*\{/))
    problems.push("the blocking handle must be written before the catch-all handle");
  return problems;
}

test("the shipped Caddyfile answers 404 for the upload counters and still proxies everything else", () => {
  assert.deepEqual(uploadCounterProblems(read("deploy/Caddyfile")), []);
});

test("earlier protections of the Caddyfile are intact", () => {
  const text = read("deploy/Caddyfile");
  assert.match(text, /request_body\s*\{\s*max_size 10MB\s*\}/);
  assert.match(text, /Strict-Transport-Security/);
  assert.match(text, /X-Content-Type-Options "nosniff"/);
  assert.match(text, /\{\$STYLE_DOMAIN\}\s*\{/);
});

test("the checker flags a Caddyfile without the block, with a wrong response, or with the order reversed", () => {
  const original = read("deploy/Caddyfile");
  const unprotected = original.replace(/\n\s*@upload_counters[\s\S]*?\n\s*handle \{/, "\n  handle {");
  assert.notEqual(unprotected, original);
  assert.ok(uploadCounterProblems(unprotected).length > 0);
  assert.ok(uploadCounterProblems(original.replace("respond 404", "respond 200")).length > 0);
  const plain = "x {\n  reverse_proxy app:3000\n}\n";
  assert.ok(uploadCounterProblems(plain).length > 0);
  const reversed = [
    "x {",
    "  @c path /api/health/uploads /api/health/uploads/*",
    "  handle {",
    "    reverse_proxy app:3000",
    "  }",
    "  handle @c {",
    "    respond 404",
    "  }",
    "}",
  ].join("\n");
  assert.match(uploadCounterProblems(reversed).join("\n"), /written before the catch-all/);
});

/**
 * Minimal, scoped reader for the shape compose.yaml actually uses: a top-level
 * `services:` block map, service names at two spaces, service keys at four,
 * values inline or as indented continuation lines (block lists, long-form
 * entries). It is NOT a YAML parser and makes no claim to be one.
 *
 * It reads ONE file, compose.yaml. It cannot see `compose.override.yaml`,
 * `include:` or `extends:` targets, `--file` combinations, profiles, or
 * variable-substituted values.
 *
 * Fail closed: instead of returning a false-safe empty answer, every helper
 * THROWS when the file has no readable `services:` map, when a requested
 * service is absent, or when it meets a construct it does not support:
 * tabs, a top-level `include:`, `extends:`, YAML anchors / aliases / `<<:`
 * merge keys, quoted or otherwise unrecognized service names, flow-style
 * `services: { ... }`, `network_mode: host` (publishes with no `ports` key),
 * and, in a `ports` value, port ranges (`2000-4000:80`) or `${...}`
 * substitution. A passing check therefore means "this file, in this shape, has
 * no service publishing the port", nothing broader.
 *
 * Full-line comments and trailing ` # comments` are removed first.
 */
export function stripYamlComments(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "");
}

const indentOf = (line: string) => line.length - line.trimStart().length;
/** The line with quoted strings blanked, so `>&2` or `"*"` inside a command is not an anchor. */
const unquoted = (line: string) => line.replace(/"[^"]*"|'[^']*'/g, '""');

/** Throws on any construct this reader does not support (see above). */
export function assertSupportedCompose(text: string): string[] {
  const lines = stripYamlComments(text);
  for (const line of lines) {
    if (/\t/.test(line)) throw new Error("unsupported compose: tab character");
    const bare = unquoted(line);
    if (indentOf(line) === 0 && /^include\s*:/.test(bare))
      throw new Error("unsupported compose: include:");
    if (/(^|\s)extends\s*:/.test(bare))
      throw new Error("unsupported compose: extends:");
    if (/<<\s*:/.test(bare)) throw new Error("unsupported compose: merge key");
    if (/(^|[\s:\-[,])[&*][A-Za-z0-9_-]+/.test(bare))
      throw new Error("unsupported compose: YAML anchor or alias");
    if (/^\s*network_mode\s*:\s*["']?host/.test(line))
      throw new Error("unsupported compose: network_mode host");
  }
  if (!lines.some((l) => /^services:\s*$/.test(l)))
    throw new Error("unsupported compose: no block-style `services:` map");
  return lines;
}

function servicesRange(lines: string[]): [number, number] {
  const at = lines.findIndex((l) => /^services:\s*$/.test(l));
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++)
    if (indentOf(lines[i]) === 0) {
      end = i;
      break;
    }
  return [at + 1, end];
}

/** Names of every service in the file, in order. Throws if none can be read. */
export function composeServiceNames(text: string): string[] {
  const lines = assertSupportedCompose(text);
  const [from, to] = servicesRange(lines);
  const names: string[] = [];
  for (let i = from; i < to; i++) {
    if (indentOf(lines[i]) !== 2) continue;
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(lines[i]);
    if (!m)
      throw new Error(`unsupported compose: unrecognized service line "${lines[i].trim()}"`);
    names.push(m[1]);
  }
  if (names.length === 0) throw new Error("compose: no services found");
  return names;
}

/** The lines of service `name` (without its header). Throws if it is absent. */
export function composeService(text: string, name: string): string[] {
  if (!composeServiceNames(text).includes(name))
    throw new Error(`compose: service "${name}" not found`);
  const lines = assertSupportedCompose(text);
  const [from, to] = servicesRange(lines);
  let start = -1;
  for (let i = from; i < to; i++)
    if (indentOf(lines[i]) === 2 && lines[i].trim() === `${name}:`) {
      start = i + 1;
      break;
    }
  const body: string[] = [];
  for (let i = start; i < to && indentOf(lines[i]) > 2; i++) body.push(lines[i]);
  return body;
}

/**
 * Everything under service key `key` (four-space indent): the inline remainder
 * plus every continuation line, whether a one-line `[...]`, a block list or a
 * long-form map. Null when the service does not have the key (a real answer:
 * the key is absent from a service that exists).
 */
export function serviceKeyText(service: string[], key: string): string | null {
  const at = service.findIndex(
    (l) => indentOf(l) === 4 && new RegExp(`^${key}:`).test(l.trim()),
  );
  if (at < 0) return null;
  const parts = [service[at].trim().slice(key.length + 1)];
  for (let i = at + 1; i < service.length; i++) {
    const l = service[i];
    // A sibling key at the same indent ends the value; a `- ` list item at
    // the same indent still belongs to it.
    if (indentOf(l) < 4 || (indentOf(l) === 4 && !l.trim().startsWith("- ")))
      break;
    parts.push(l.trim());
  }
  return parts.join("\n");
}

/**
 * Names of the services whose `ports` mention `port` as a number anywhere.
 * Throws for no readable services and for `ports` values it cannot judge
 * (ranges, `${...}`), instead of answering "none".
 */
export function servicesPublishing(text: string, port: number): string[] {
  const token = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`);
  return composeServiceNames(text).filter((name) => {
    const ports = serviceKeyText(composeService(text, name), "ports");
    if (ports === null) return false;
    if (/\d+\s*-\s*\d+/.test(ports))
      throw new Error(`unsupported compose: port range in service "${name}"`);
    if (/\$\{|\$[A-Za-z_]/.test(ports))
      throw new Error(`unsupported compose: substitution in ports of "${name}"`);
    return token.test(ports);
  });
}

const sampleCompose = (ports: string) =>
  [
    "services:",
    "  web:",
    "    image: x",
    ports,
    "    expose:",
    '      - "3000"',
    "  other:",
    '    ports: ["8080:80"]',
    "volumes:",
    "  data:",
  ].join("\n");

test("the compose reader sees one-line, block-list and long-form ports, and ignores comments and `expose`", () => {
  const sample = sampleCompose;
  assert.deepEqual(servicesPublishing(sample('    ports: ["80:80"]'), 3000), []);
  assert.deepEqual(servicesPublishing(sample('    ports: ["3000:3000"]'), 3000), ["web"]);
  assert.deepEqual(
    servicesPublishing(sample('    ports:\n      - "80:80"\n      - "127.0.0.1:3000:3000"'), 3000),
    ["web"],
    "a later entry of a multi-line list is found",
  );
  assert.deepEqual(
    servicesPublishing(sample("    ports:\n    - '80:80'\n    - 3000:3000"), 3000),
    ["web"],
    "list items at the key's own indent are part of the key",
  );
  assert.deepEqual(
    servicesPublishing(sample("    ports:\n      - target: 3000\n        published: 8080"), 3000),
    ["web"],
    "long form",
  );
  assert.deepEqual(
    servicesPublishing(sample('    # ports: ["3000:3000"]\n    ports: ["80:80"] # not 3000'), 3000),
    [],
    "comments do not count",
  );
  assert.deepEqual(servicesPublishing(sample('    ports: ["80:80"]'), 8080), ["other"]);
  assert.deepEqual(servicesPublishing(sample('    ports: ["13000:80"]'), 3000), [], "a longer number is not 3000");
  assert.deepEqual(composeServiceNames(sample('    ports: ["80:80"]')), ["web", "other"]);
  assert.equal(serviceKeyText(composeService(sample('    ports: ["80:80"]'), "web"), "labels"), null, "an absent KEY on an existing service is null");
});

test("the compose reader throws, instead of answering a false-safe empty result, for absent or unsupported input", () => {
  const ok = sampleCompose('    ports: ["80:80"]');
  // Absent service or no services at all.
  assert.throws(() => composeService(ok, "missing"), /not found/);
  assert.throws(() => composeServiceNames("version: '3'\nvolumes:\n  data:\n"), /services/);
  assert.throws(() => servicesPublishing("", 3000), /services/);
  assert.throws(() => composeServiceNames("services:\nvolumes:\n  data:\n"), /no services/);
  // Indentation the reader does not expect: services appear at four spaces.
  assert.throws(
    () => servicesPublishing("services:\n    web:\n        ports: [\"3000:3000\"]\n", 3000),
    /unsupported|no services/,
  );
  // Flow-style services map and quoted service names.
  assert.throws(() => composeServiceNames('services: { web: { image: x } }\n'), /services/);
  assert.throws(
    () => composeServiceNames('services:\n  "web":\n    image: x\n'),
    /unrecognized service line/,
  );
  // Constructs that can publish a port without the plain `ports:` shape.
  const withLine = (line: string) => ok.replace("    image: x", `    image: x\n${line}`);
  for (const [label, line, pattern] of [
    ["network_mode host", "    network_mode: host", /network_mode/],
    ["extends", "    extends:\n      file: other.yaml\n      service: x", /extends/],
    ["tab", "\timage: y", /tab/],
    ["anchor", "    image: &img x", /anchor/],
    ["alias", "    image: *img", /anchor/],
    ["merge key", "    <<: *base", /merge|anchor/],
  ] as const)
    assert.throws(() => servicesPublishing(withLine(line), 3000), pattern, label);
  assert.throws(
    () => servicesPublishing("include:\n  - other.yaml\n" + ok, 3000),
    /include/,
  );
  // Port values it cannot judge.
  assert.throws(() => servicesPublishing(sampleCompose('    ports: ["2000-4000:80"]'), 3000), /range/);
  assert.throws(() => servicesPublishing(sampleCompose('    ports: ["${APP_PORT}:3000"]'), 3000), /substitution/);
  // Quoted strings are not mistaken for anchors, and a `command` with `>&2` is fine.
  assert.deepEqual(
    servicesPublishing(sampleCompose('    command: ["sh", "-c", "echo hi >&2; exit 1"]'), 3000),
    [],
  );
});

test("the real compose.yaml is in a shape the reader supports, and nothing next to it overrides it", () => {
  const compose = read("compose.yaml");
  assert.deepEqual(composeServiceNames(compose), ["app", "worker", "mailer", "ollama", "proxy"]);
  // The reader sees only compose.yaml; at least show that this checkout has no
  // override or alternative file that Compose would merge automatically. This
  // says nothing about the server the operator deploys to.
  for (const name of [
    "compose.override.yaml",
    "compose.override.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "docker-compose.override.yml",
    "docker-compose.override.yaml",
  ])
    assert.equal(existsSync(path.join(root, name)), false, `${name} must not exist`);
});

test("the app port is not published, so the counters stay internal; the route itself still exists", () => {
  const compose = read("compose.yaml");
  assert.deepEqual(servicesPublishing(compose, 3000), [], "no service publishes 3000");
  const app = composeService(compose, "app");
  assert.match(serviceKeyText(app, "expose") ?? "", /["']?3000["']?/);
  assert.equal(serviceKeyText(app, "ports"), null, "the app has no ports key at all");
  const proxy = composeService(compose, "proxy");
  const published = serviceKeyText(proxy, "ports") ?? "";
  assert.match(published, /80:80/);
  assert.match(published, /443:443/);
  assert.ok(existsSync(path.join(root, "src/app/api/health/uploads/route.ts")));
});

test("the proxy receives only STYLE_DOMAIN: no env_file, no app secrets, and the Caddyfile reads nothing else", () => {
  const compose = read("compose.yaml");
  const proxy = composeService(compose, "proxy");
  assert.equal(serviceKeyText(proxy, "env_file"), null, "the proxy must not load .env.production");
  const environment = serviceKeyText(proxy, "environment");
  assert.ok(environment !== null, "the proxy declares its environment explicitly");
  const keys = environment
    .split("\n")
    .map((l) => l.trim().replace(/^-\s*/, ""))
    .filter(Boolean)
    .map((l) => l.split(/[:=]/)[0].trim());
  assert.deepEqual(keys, ["STYLE_DOMAIN"]);
  assert.match(environment, /\$\{STYLE_DOMAIN(:-[^}]*)?\}/, "filled by Compose substitution, with a default");
  assert.doesNotMatch(environment, /AUTH_SECRET|SMTP|MAIL_FROM/);
  // Every environment variable the Caddyfile reads is one the proxy gets.
  const read_ = [...read("deploy/Caddyfile").matchAll(/\{\$([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(read_)], ["STYLE_DOMAIN"]);
  // The services that need the secrets still get them.
  for (const name of ["app", "worker", "mailer"])
    assert.match(
      serviceKeyText(composeService(compose, name), "env_file") ?? "",
      /\.env\.production/,
      `${name} keeps env_file`,
    );
  // The detector itself: a proxy that loads the whole file is reported.
  const regressed = compose.replace(
    /( {4})environment:\r?\n {6}STYLE_DOMAIN:[^\r\n]*\r?\n/,
    "$1env_file: .env.production\n",
  );
  assert.notEqual(regressed, compose);
  assert.notEqual(serviceKeyText(composeService(regressed, "proxy"), "env_file"), null);
});

/**
 * The guard is a command written in compose.yaml and run by a container shell.
 * Nothing here runs it; these checks only read its text.
 */
test("the proxy command refuses to start without STYLE_DOMAIN before it execs caddy, with Compose-escaped variables and the standard caddy command", () => {
  const compose = read("compose.yaml");
  const command = serviceKeyText(composeService(compose, "proxy"), "command");
  assert.ok(command !== null, "the proxy has an explicit command");
  const items = command
    .split("\n")
    .map((l) => l.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
  assert.deepEqual(items.slice(0, 2), ["sh", "-c"]);
  assert.equal(items.length, 3, "sh -c <one script>");
  const script = items[2];
  // `$$` is Compose's escape for a literal `$`: the container shell, not
  // Compose, must expand the variable. A single `$STYLE_DOMAIN` here would be
  // substituted by Compose at parse time and the guard would test a constant.
  assert.match(script, /\$\$STYLE_DOMAIN/);
  assert.doesNotMatch(script, /(^|[^$])\$\{?STYLE_DOMAIN/, "no unescaped Compose substitution inside the guard");
  assert.match(script, /^'?test -n "\$\$STYLE_DOMAIN"/);
  assert.match(script, /STYLE_DOMAIN is not set/);
  assert.match(script, />&2/);
  assert.match(script, /exit 1/);
  assert.match(script, /exec caddy run --config \/etc\/caddy\/Caddyfile --adapter caddyfile/);
  assert.ok(
    script.indexOf("exit 1") < script.indexOf("exec caddy"),
    "the failure path comes before caddy is started",
  );
  assert.equal((script.match(/exec caddy/g) ?? []).length, 1);
  // The Caddyfile the guard protects is the one the standard command reads.
  assert.match(
    serviceKeyText(composeService(compose, "proxy"), "volumes") ?? "",
    /\.\/deploy\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/,
  );
});

test(".env.compose.example is a domain-only, secret-free Compose template with a public placeholder", () => {
  assert.ok(existsSync(path.join(root, ".env.compose.example")));
  const lines = read(".env.compose.example")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  assert.equal(lines.length, 1, "exactly one assignment");
  const match = /^STYLE_DOMAIN=(.+)$/.exec(lines[0]);
  assert.ok(match, "it sets STYLE_DOMAIN");
  assert.match(match[1], /\.example$/, "a reserved illustrative domain, not a real one");
  assert.doesNotMatch(read(".env.compose.example"), /AUTH_SECRET=|SMTP_URL=|MAIL_FROM=|password|token/i);
});

test("the deployment guide has the domain file steps before the compose commands, keeps --env-file as an alternative, and claims no Compose version", () => {
  const guide = read("docs/DEPLOYMENT.md");
  const copy = guide.indexOf("[ -e .env ] || cp .env.compose.example .env");
  const build = guide.indexOf("docker compose build");
  assert.ok(copy > 0, "the copy command is written down");
  assert.ok(build > copy, "the domain file step comes BEFORE the first compose command block");
  assert.match(guide, /Never overwrites an existing \.env/);
  assert.match(guide, /--env-file \.env\.production/);
  assert.match(guide, /only `STYLE_DOMAIN`/);
  assert.match(guide, /STYLE_DOMAIN is not set/);
  assert.match(guide, /never run/i);
  // COMPOSE_ENV_FILES may be mentioned, but its minimum version is not established here.
  assert.doesNotMatch(guide, /\b2\.(24|32)(\.\d+)?\b/, "no unverified Compose version claim");
  assert.match(guide, /not established/);
  // The restore procedure's bare `docker compose up -d` is covered by the durable file.
  assert.match(guide, /fresh shell/);
});

test("the deployment guide documents the default block and the operator way in", () => {
  const guide = read("docs/DEPLOYMENT.md");
  assert.match(guide, /deploy\/Caddyfile` answers `404` for `\/api\/health\/uploads`/);
  assert.match(guide, /docker compose exec app node -e "fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health\/uploads'\)/);
});
