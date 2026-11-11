import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  LAUNCH_ENV,
  LAUNCH_KINDS,
  LAUNCH_PATH,
  assertLaunchInfoConfigured,
  isPublicHostname,
  launchDestination,
  parseLaunchUrl,
  resolveLaunchInfo,
} from "../src/server/launchInfo";
import { escapeHtml, launchResponse, supportMailtoResponse, unavailableResponse } from "../src/server/launchRoute";
import { SMOKE_LAUNCH, SMOKE_LAUNCH_LINES, appEnvFile, launchRouteProblems } from "../scripts/ci-compose-smoke-plan";

/**
 * Build 032: fail-closed launch information. These tests pin behaviour (strict parsing, readiness, the routes'
 * fixed responses, same-origin links, Compose/CI wiring, documentation). They do not judge whether any privacy
 * notice or terms are adequate: no document exists in this repository and none is claimed.
 */

const root = process.cwd();
const read = (f: string) => readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
const SECRET = "SECRETMARKER-9f3a";
const publicEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  STYLE_PUBLIC_DEPLOYMENT: "true",
  STYLE_PRIVACY_URL: "https://style.example.com/privacy",
  STYLE_TERMS_URL: "https://style.example.com/terms",
  STYLE_SUPPORT_URL: "mailto:support@style.example.com",
  ...over,
});

// ------------------------------------------------------------------ parsing

test("accepted public values: canonical https URLs, a bare origin, a query, and for support a single mailto address", () => {
  const ok = (kind: (typeof LAUNCH_KINDS)[number], v: string, expected = v) => assert.deepEqual(parseLaunchUrl(kind, v, true), { ok: true, url: expected }, v);
  ok("privacy", "https://style.example.com/privacy");
  ok("terms", "https://legal.example.co.uk/terms/v2?lang=en");
  ok("privacy", "https://example.com", "https://example.com/");
  ok("privacy", "  https://style.example.com/privacy \n", "https://style.example.com/privacy");
  ok("support", "https://help.example.org/contact");
  ok("support", "mailto:support@style.example.com");
  ok("support", "mailto:first.last+style@example.co.uk");
  ok("privacy", "https://xn--bcher-kva.example.com/p");
});

test("rejected public values: wrong scheme, relative, credentials, fragments, control and hidden characters, odd spelling, odd ports", () => {
  const bad: string[] = [
    "", "   ", "privacy", "/privacy", "//style.example.com/privacy", "http://style.example.com/privacy", "ftp://style.example.com/p",
    "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "HTTPS://style.example.com/p", "https://Style.Example.com/p",
    "https://user:pw@style.example.com/p", "https://user@style.example.com/p", "https://@style.example.com/p", `https://${SECRET}:x@style.example.com/p`,
    "https://style.example.com/p#frag", "https://style.example.com/p#", "https://style.example.com:8443/p", "https://style.example.com:443/p",
    "https://style.example.com/a/../p", "https://style.example.com/a/./p", "https://style.example.com\\p", "https://style.example.com/p q",
    "https://style.example.com/p\nSet-Cookie: x=1", "https://style.example.com/p\tq", "https://style.example.com/\u0000", "https://style.example.com/‮",
    "https://stylé.example.com/p", "https://style.example.com/é", "https://style.example.com?x=1", "https://style.example.com./p",
    `https://style.example.com/${"a".repeat(2100)}`,
  ];
  for (const v of bad) assert.deepEqual(parseLaunchUrl("privacy", v, true), { ok: false }, JSON.stringify(v).slice(0, 80));
  for (const v of [undefined, null, 5, {}, [], true]) assert.deepEqual(parseLaunchUrl("terms", v, true), { ok: false }, String(v));
});

test("rejected public hosts: loopback, private and numeric addresses, single labels and internal or reserved suffixes", () => {
  const hosts = [
    "localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1", "0.0.0.0", "10.0.0.5", "192.168.1.1", "169.254.169.254", "8.8.8.8", "2130706433",
    "0x7f000001", "[::1]", "[2001:db8::1]", "intranet", "nas.local", "svc.internal", "host.localdomain", "printer.lan", "router.home.arpa",
    "site.test", "site.invalid", "site.example", "style.example.com.", "-bad.example.com", "bad-.example.com", "a..b.example.com", "x.123",
  ];
  for (const h of hosts) {
    assert.equal(isPublicHostname(h.replace(/^\[|\]$/g, "")), false, h);
    assert.deepEqual(parseLaunchUrl("privacy", `https://${h}/privacy`, true), { ok: false }, h);
  }
  assert.equal(isPublicHostname("style.example.com"), true);
  assert.equal(isPublicHostname("example.com"), true);
  assert.equal(isPublicHostname("a.b.c.example.org"), true);
});

test("mailto is only for support and only a single plain public address", () => {
  const bad = [
    "mailto:", "mailto:support", "mailto:@example.com", "mailto:a@b", "mailto:a@localhost", "mailto:a@127.0.0.1", "mailto:a@nas.local", "mailto:a@x.internal",
    "mailto:a@example.com?subject=hi", "mailto:a@example.com,b@example.com", "mailto:a@example.com;b@example.com", "mailto:Name <a@example.com>",
    "mailto:a%40example.com", "mailto:.a@example.com", "mailto:a..b@example.com", "mailto:a@example.com\nBcc: x@evil.example.com", "mailto:a@example.com#x", "MAILTO:a@example.test",
  ];
  for (const v of bad) assert.deepEqual(parseLaunchUrl("support", v, true), { ok: false }, JSON.stringify(v));
  for (const kind of ["privacy", "terms"] as const) assert.deepEqual(parseLaunchUrl(kind, "mailto:support@style.example.com", true), { ok: false }, `${kind} may not be a mailto`);
});

test("local development may use http and internal hosts, but every other rule still applies", () => {
  assert.deepEqual(parseLaunchUrl("privacy", "http://localhost:3000/privacy", false), { ok: true, url: "http://localhost:3000/privacy" });
  assert.deepEqual(parseLaunchUrl("support", "mailto:me@localhost", false), { ok: true, url: "mailto:me@localhost" });
  for (const v of ["https://user:pw@localhost/p", "http://localhost/p#x", "http://localhost/p\nx", "javascript:alert(1)", "http://localhost/a/../p", "mailto:a@x?subject=1"])
    assert.deepEqual(parseLaunchUrl("privacy", v, false).ok, false, v);
  // the same http value is refused in a public deployment
  assert.deepEqual(parseLaunchUrl("privacy", "http://localhost:3000/privacy", true), { ok: false });
});

test("a bad value yields the fixed failure and is never echoed in the result or in the thrown readiness message", () => {
  const hostile = [`https://${SECRET}:pw@style.example.com/p`, `https://style.example.com/${SECRET}#x`, `http://${SECRET}.localhost/p`, `${SECRET}\nSet-Cookie: a=b`, `mailto:${SECRET}@localhost`];
  for (const h of hostile) {
    const d = parseLaunchUrl("privacy", h, true);
    assert.deepEqual(d, { ok: false });
    assert.deepEqual(Object.keys(d), ["ok"], "no field that could carry the value or a reason");
    const env = publicEnv({ STYLE_PRIVACY_URL: h, STYLE_TERMS_URL: h, STYLE_SUPPORT_URL: h });
    assert.throws(() => assertLaunchInfoConfigured(env), (e: Error) => !e.message.includes(SECRET) && !/pw@|Set-Cookie/.test(e.message));
    assert.ok(!JSON.stringify(resolveLaunchInfo(env)).includes(SECRET), "resolveLaunchInfo never holds the bad value");
  }
});

// ------------------------------------------------------------------ readiness rule

test("public deployment needs all three; local development needs none; the message names only the variables", () => {
  assert.doesNotThrow(() => assertLaunchInfoConfigured(publicEnv()));
  for (const kind of LAUNCH_KINDS) {
    const env = publicEnv({ [LAUNCH_ENV[kind]]: undefined });
    assert.throws(() => assertLaunchInfoConfigured(env), (e: Error) => e.message.includes(LAUNCH_ENV[kind]) && LAUNCH_KINDS.filter((k) => k !== kind).every((k) => !e.message.includes(LAUNCH_ENV[k])));
    assert.deepEqual(resolveLaunchInfo(env).missing, [kind]);
    const invalid = publicEnv({ [LAUNCH_ENV[kind]]: "http://nope.localhost/" });
    assert.throws(() => assertLaunchInfoConfigured(invalid), (e: Error) => e.message.includes(LAUNCH_ENV[kind]) && !e.message.includes("nope"));
  }
  assert.throws(() => assertLaunchInfoConfigured({ STYLE_PUBLIC_DEPLOYMENT: "true" }), /STYLE_PRIVACY_URL, STYLE_TERMS_URL, STYLE_SUPPORT_URL/);
  // not public: nothing is required, whatever is or is not set (only the exact word "true" means public)
  for (const flag of [undefined, "false", "", "TRUE", "1", "yes"]) assert.doesNotThrow(() => assertLaunchInfoConfigured({ STYLE_PUBLIC_DEPLOYMENT: flag }), String(flag));
  assert.equal(resolveLaunchInfo({}).complete, false, "unset values are reported as missing");
  assert.equal(resolveLaunchInfo(publicEnv()).complete, true);
});

// ------------------------------------------------------------------ routes

test("https destinations redirect 307 to exactly the validated value, uncached, ignoring anything in the request", async () => {
  // support is an https URL here, so all three redirect (a mailto: support gets the contact page, tested below)
  const env = publicEnv({ STYLE_SUPPORT_URL: "https://help.style.example.com/contact" });
  for (const kind of LAUNCH_KINDS) {
    const r = launchResponse(kind, env);
    assert.equal(r.status, 307);
    assert.equal(r.headers.get("Location"), launchDestination(kind, env));
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(await r.text(), "");
  }
  assert.equal(launchResponse("support", env).headers.get("Location"), "https://help.style.example.com/contact");
  // the route modules take no argument: there is no request input to build a Location from
  for (const [kind, file] of [["privacy", "privacy"], ["terms", "terms"], ["support", "support"]] as const) {
    const source = read(`src/app/${file}/route.ts`);
    assert.match(source, new RegExp(`launchResponse\\("${kind}"\\)`));
    assert.match(source, /export function GET\(\) \{/, "GET takes no request");
    assert.doesNotMatch(source, /\b(Request|request|searchParams|nextUrl|headers|cookies|NextResponse\.redirect|new URL)\b/);
    assert.match(source, /force-dynamic/, "read at request time, not at build");
    assert.equal(LAUNCH_PATH[kind], `/${file}`);
  }
});

test("a mailto: support destination is NOT redirected to: /support returns a fixed 200 contact page with one plain link", async () => {
  const env = publicEnv(); // STYLE_SUPPORT_URL=mailto:support@style.example.com
  const r = launchResponse("support", env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Location"), null, "no redirect to a non-http scheme (browsers may refuse it as unsafe)");
  assert.match(r.headers.get("Content-Type") ?? "", /^text\/html; charset=utf-8$/);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(r.headers.get("X-Robots-Tag") ?? "", /noindex, nofollow/);
  assert.equal(r.headers.get("Content-Security-Policy"), "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'");
  const body = await r.text();
  assert.match(body, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(body, /<h1>Support<\/h1>/);
  assert.equal((body.match(/<a /g) ?? []).length, 1, "exactly one link");
  assert.match(body, /<p>To contact support, email:<\/p><p><a href="mailto:support@style\.example\.com">support@style\.example\.com<\/a><\/p>/, "plain mailto link, labelled, with the address as its text");
  assert.doesNotMatch(body, /<script|<form|<iframe|<img|<link|\son[a-z]+=|https?:\/\//i, "nothing else: no script, form, embed, handler or external URL");
  // fixed structure: only the address differs between two valid configurations
  const other = await launchResponse("support", publicEnv({ STYLE_SUPPORT_URL: "mailto:help+style@example.co.uk" })).text();
  assert.equal(other.replace("help+style@example.co.uk", "support@style.example.com").replace("help+style@example.co.uk", "support@style.example.com"), body);
  // privacy and terms are unaffected by a mailto support value
  assert.equal(launchResponse("privacy", env).status, 307);
  assert.equal(launchResponse("terms", env).status, 307);
});

test("escaping: the address is escaped in the href and the text, and a hostile or invalid support value never becomes a page or a link", async () => {
  // defence in depth: even if a value with markup characters reached the renderer, it could not break out
  const page = await supportMailtoResponse('mailto:a&b"><script>x</script>@example.com').text();
  assert.ok(!/<script|<\/script>/.test(page) && !page.includes('b"><'), "no raw markup from the value, and no attribute break-out");
  assert.match(page, /a&amp;b&quot;&gt;&lt;script&gt;x&lt;\/script&gt;@example\.com/);
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  // a legal but unusual address: & and ' are valid mailbox characters and are escaped, not dropped
  const odd = await launchResponse("support", publicEnv({ STYLE_SUPPORT_URL: "mailto:o'brien&sons@example.com" })).text();
  assert.match(odd, /href="mailto:o&#39;brien&amp;sons@example\.com">o&#39;brien&amp;sons@example\.com<\/a>/);
  // invalid values keep the fixed value-free 503, never a page that contains the value
  for (const v of [undefined, "", `mailto:${SECRET}@localhost`, `mailto:${SECRET}@example.com?subject=x`, `mailto:a@example.com,${SECRET}@example.com`, "mailto:Name <a@example.com>", `javascript:${SECRET}`, "http://help.style.example.com/"]) {
    const r = launchResponse("support", publicEnv({ STYLE_SUPPORT_URL: v }));
    assert.equal(r.status, 503, String(v));
    assert.equal(r.headers.get("Location"), null);
    const body = await r.text();
    assert.ok(!body.includes(SECRET) && !/mailto|<a /.test(body), "no value, no link");
  }
});

test("a missing or invalid configuration gets one fixed 503, no-store, non-indexable page that never contains the value", async () => {
  const bodies = new Set<string>();
  for (const v of [undefined, "", `https://${SECRET}:pw@style.example.com/p`, `http://${SECRET}.localhost/`, `javascript:${SECRET}`, `${SECRET}\r\nLocation: https://evil.example.com/`]) {
    const r = launchResponse("privacy", publicEnv({ STYLE_PRIVACY_URL: v }));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("Location"), null, "never a redirect");
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.match(r.headers.get("X-Robots-Tag") ?? "", /noindex/);
    assert.match(r.headers.get("Content-Type") ?? "", /^text\/html/);
    const body = await r.text();
    assert.match(body, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(!body.includes(SECRET) && !body.includes("evil"), "the bad value is not in the page");
    bodies.add(body);
    for (const [, header] of r.headers) assert.ok(!header.includes(SECRET), "nor in a header");
  }
  assert.equal(bodies.size, 1, "the page is identical whatever the bad value was");
  // not configured at all in local development: the same fixed page, no invented operator identity
  const local = await unavailableResponse("support").text();
  assert.match(local, /support contact/);
  assert.doesNotMatch(local, /@|https?:\/\/|Inc\.|Ltd|LLC|GmbH|Privacy Policy|Terms of (Service|Use)/i);
});

test("a destination changed in the environment is picked up on the next request (runtime, not build time)", () => {
  const env = publicEnv();
  assert.equal(launchResponse("terms", env).headers.get("Location"), "https://style.example.com/terms");
  env.STYLE_TERMS_URL = "https://style.example.com/terms-v2";
  assert.equal(launchResponse("terms", env).headers.get("Location"), "https://style.example.com/terms-v2");
  env.STYLE_TERMS_URL = "not a url";
  assert.equal(launchResponse("terms", env).status, 503);
  for (const dir of ["src"]) for (const f of walk(dir)) assert.doesNotMatch(read(f), /NEXT_PUBLIC_(STYLE_)?(PRIVACY|TERMS|SUPPORT)/, `${f}: build-time public variable`);
});

// ------------------------------------------------------------------ links at the collection points

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

test("the sign-in / sign-up screen, the signed-in footer and the photo-consent control carry plain same-origin links, with no new consent step", () => {
  const links = read("src/components/LaunchInfoLinks.tsx");
  const hrefs = [...links.matchAll(/\["(\/[a-z]+)", "/g)].map((m) => m[1]).sort();
  assert.deepEqual(hrefs, Object.values(LAUNCH_PATH).sort(), "exactly /privacy, /terms and /support");
  assert.match(links, /<a key=\{href\} href=\{href\}/, "ordinary anchors");
  assert.doesNotMatch(links, /from "next\/link"|<Link\b|<button|onClick|https?:\/\//, "no client routing, no button, no external URL");
  assert.match(links, /<a href="\/privacy" target="_blank" rel="noopener noreferrer">/, "the photo link opens in a new tab without opener");

  const auth = read("src/components/AuthScreen.tsx");
  assert.match(auth, /import \{ LaunchInfoLinks \} from "\.\/LaunchInfoLinks"/);
  assert.match(auth, /<\/small>\s*<LaunchInfoLinks \/>\s*<\/section>/, "inside the card, visible in every mode (sign in, create account, reset)");
  assert.doesNotMatch(auth, /LaunchInfoLinks \/>[\s\S]*mode === "signup" &&[\s\S]*LaunchInfoLinks/, "not hidden behind a mode");

  const page = read("src/app/page.tsx");
  assert.match(page, /<\/label>\s*<LaunchInfoLinks \/>\s*<\/footer>/, "in the signed-in footer");

  const upload = read("src/components/UploadDialog.tsx");
  assert.match(upload, /Allow the server to analyze this photo\.\s*<\/label>\s*<PhotoPrivacyLink \/>/, "right after the consent control");
  assert.equal((upload.match(/setConsent\(/g) ?? []).length, 1, "the one existing consent state, not a second");
  assert.doesNotMatch(upload, /type="checkbox"[^>]*\b(privacy|terms)/i, "no new privacy or terms checkbox");
  assert.doesNotMatch(auth + upload, /\bI (agree|accept)\b|agree to the (terms|privacy)/i, "no acceptance semantics were invented");
  for (const f of walk("src/components")) assert.doesNotMatch(read(f), /from "\.\.\/server\/launchInfo"|from "\.\.\/server\/launchRoute"/, `${f}: client code never imports the server module`);
});

// ------------------------------------------------------------------ Compose and CI wiring

test("Compose wires the settings through .env.production only: no entry in compose.yaml, no worker, mailer or proxy exposure, no empty override", () => {
  const compose = read("compose.yaml");
  const code = compose.replace(/^\s*#.*$/gm, "");
  for (const name of Object.values(LAUNCH_ENV)) {
    assert.ok(!code.includes(name), `${name} is not a compose entry (an environment: entry with an empty default would override .env.production)`);
    assert.ok(compose.includes(name), `${name} is documented in a compose comment`);
  }
  assert.match(compose, /# Build 032 launch information:[\s\S]*set in .env.production/);
  const app = /\n {2}app:\n([\s\S]*?)\n {2}worker:\n/.exec(compose)?.[1] ?? "";
  assert.match(app, /env_file: \.env\.production/, "the app reads .env.production");
  const proxy = /\n {2}proxy:\n([\s\S]*)$/.exec(code)?.[1] ?? "";
  assert.ok(proxy.length > 0, "the proxy service was found");
  assert.doesNotMatch(proxy, /env_file/, "the proxy never loads .env.production, so it never sees these settings either");
  assert.ok(!/launchInfo|STYLE_(PRIVACY|TERMS|SUPPORT)_URL/.test(read("scripts/analysis-worker.ts") + read("scripts/mail-worker.ts")), "the workers do not use them");
});

test("the CI smoke test supplies valid PUBLIC destinations on example.com, not .localhost (which the app refuses)", () => {
  assert.equal(SMOKE_LAUNCH_LINES.length, 3);
  const env = appEnvFile({ authSecret: "a".repeat(40) });
  const values: Record<string, string> = {};
  for (const l of SMOKE_LAUNCH_LINES) {
    assert.ok(env.includes(l), l);
    const [k, ...v] = l.split("=");
    values[k] = v.join("=");
    assert.ok(!/localhost/.test(l), "the app refuses .localhost destinations in public mode");
  }
  assert.deepEqual(Object.keys(values).sort(), Object.values(LAUNCH_ENV).sort());
  assert.doesNotThrow(() => assertLaunchInfoConfigured({ STYLE_PUBLIC_DEPLOYMENT: "true", ...values }), "the smoke values are accepted by the real validator");
  assert.deepEqual(parseLaunchUrl("privacy", "https://style-ci.localhost/privacy", true), { ok: false }, "and the .localhost spelling would not have been");
  assert.match(read("scripts/ci-compose-smoke-plan.ts"), /no request is ever made to them/);
});

test("the live smoke check accepts the real routes' answers and rejects wrong ones; it only inspects answers and never follows a destination", async () => {
  const env = publicEnv({ STYLE_PRIVACY_URL: SMOKE_LAUNCH.privacy, STYLE_TERMS_URL: SMOKE_LAUNCH.terms, STYLE_SUPPORT_URL: SMOKE_LAUNCH.support });
  const answer = async (kind: (typeof LAUNCH_KINDS)[number], e = env) => {
    const r = launchResponse(kind, e);
    return { status: r.status, rawHeaders: [...r.headers].flat(), body: await r.text() };
  };
  assert.deepEqual(launchRouteProblems("/privacy", await answer("privacy")), []);
  assert.deepEqual(launchRouteProblems("/terms", await answer("terms")), []);
  assert.deepEqual(launchRouteProblems("/support", await answer("support")), []);
  const support = await answer("support");
  const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), problems.join(" | "));
  has(launchRouteProblems("/support", { ...support, status: 307, rawHeaders: [...support.rawHeaders, "location", SMOKE_LAUNCH.support], body: "" }), /redirect to a mailto/);
  has(launchRouteProblems("/support", { ...support, status: 503 }), /expected the 200/);
  has(launchRouteProblems("/support", { ...support, body: support.body.replace(/<a href="mailto:[^"]+">/, '<a href="mailto:other@example.com">') }), /exactly one plain mailto link/);
  has(launchRouteProblems("/support", { ...support, body: `${support.body}<a href="mailto:support@style-ci.example.com">x</a>` }), /exactly one plain mailto link/);
  has(launchRouteProblems("/support", { ...support, body: support.body.replace("</main>", '<p>https://evil.example.com/</p></main>') }), /over http/);
  /** Removes one header (name and value pair) from a flat [name, value, ...] list. */
  const without = (raw: string[], name: string) => raw.filter((_, i) => raw[i - (i % 2)] !== name);
  has(launchRouteProblems("/support", { ...support, rawHeaders: without(support.rawHeaders, "x-robots-tag") }), /not marked noindex/);
  has(launchRouteProblems("/support", { ...support, rawHeaders: without(support.rawHeaders, "content-type") }), /not an HTML page/);
  const privacy = await answer("privacy");
  has(launchRouteProblems("/privacy", { ...privacy, status: 200 }), /expected 307/);
  has(launchRouteProblems("/privacy", { ...privacy, rawHeaders: ["cache-control", "no-store", "location", "https://evil.example.com/"] }), /Location is not the configured/);
  has(launchRouteProblems("/privacy", { ...privacy, body: "x" }), /has a body/);
  has(launchRouteProblems("/terms", { ...privacy }), /Location is not the configured/);
  has(launchRouteProblems("/privacy", { ...privacy, rawHeaders: without(privacy.rawHeaders, "cache-control") }), /Cache-Control is not no-store/);
  // wired into the live scenario for both paths, and no external destination is ever requested
  const smoke = read("scripts/ci-compose-smoke.ts");
  assert.match(smoke, /launchRouteProblems\(route, answer\)/);
  assert.match(smoke, /\["direct", live\], \["through the proxy", throughProxy\]/);
  assert.match(smoke, /for \(const route of \["\/privacy", "\/terms", "\/support"\] as const\)/);
  assert.doesNotMatch(smoke.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""), /example\.com|SMOKE_LAUNCH\b/, "the live scenario never uses a destination as a request target");
});

// ------------------------------------------------------------------ readiness through the real auth path and health route

const dir = path.join(process.cwd(), ".data", "tests", `launch032-${randomUUID()}`);
const saved: Record<string, string | undefined> = {};
const KEYS = ["STYLE_DATA_DIR", "STYLE_PUBLIC_DEPLOYMENT", "APP_URL", "AUTH_SECRET", "SMTP_URL", "MAIL_FROM", ...Object.values(LAUNCH_ENV)];
let health: () => Promise<Response>;
let auth: typeof import("../src/server/auth");
let database: typeof import("../src/server/database");

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    STYLE_DATA_DIR: dir,
    STYLE_PUBLIC_DEPLOYMENT: "true",
    APP_URL: "https://style.example.com",
    AUTH_SECRET: "x".repeat(48),
    SMTP_URL: "smtp://127.0.0.1:2525",
    MAIL_FROM: "Style Studio <no-reply@style.example.com>",
  });
  for (const k of Object.values(LAUNCH_ENV)) delete process.env[k];
  auth = await import("../src/server/auth");
  database = await import("../src/server/database");
  health = (await import("../src/app/api/health/route")).GET;
});
after(() => {
  try {
    database?.closeDatabases();
  } finally {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Everything written to the console while `body` runs. */
async function captured<T>(body: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const sink = console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const k of Object.keys(originals)) sink[k] = (...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? `${x.message}\n${x.stack ?? ""}` : String(x))).join(" "));
  try {
    return { value: await body(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, originals);
  }
}

test("public mode without launch information is not ready: fixed { ready: false }, no reason, and the auth build refuses", async () => {
  const { value: response, logs } = await captured(() => health());
  assert.equal(response.status, 503);
  assert.equal(await response.text(), JSON.stringify({ ready: false }), "the fixed public body, nothing else");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.ok(!/STYLE_PRIVACY|STYLE_TERMS|STYLE_SUPPORT/.test(logs), "the public route logs nothing about it");
  await assert.rejects(auth.getReadyAuth(), /STYLE_PRIVACY_URL, STYLE_TERMS_URL, STYLE_SUPPORT_URL/);
});

test("hostile launch values keep it not ready, and the value appears in no response and no log", async () => {
  process.env.STYLE_PRIVACY_URL = `https://${SECRET}:pw@style.example.com/p`;
  process.env.STYLE_TERMS_URL = `http://${SECRET}.localhost/terms`;
  process.env.STYLE_SUPPORT_URL = `mailto:${SECRET}@127.0.0.1?subject=${SECRET}`;
  const { value: response, logs } = await captured(async () => {
    const r = await health();
    const body = await r.text();
    let thrown = "";
    await auth.getReadyAuth().catch((e: Error) => void (thrown = e.message));
    return { status: r.status, body, thrown, headers: [...r.headers].join("|") };
  });
  assert.equal(response.status, 503);
  assert.equal(response.body, JSON.stringify({ ready: false }));
  assert.ok(response.thrown.includes("STYLE_PRIVACY_URL"), "the operator is told WHICH variables");
  for (const text of [response.body, response.thrown, response.headers, logs]) assert.ok(!text.includes(SECRET) && !text.includes("pw@"), "the bad value is never emitted");
  // the routes give the fixed unavailable page for the same values
  for (const kind of LAUNCH_KINDS) {
    const r = launchResponse(kind);
    assert.equal(r.status, 503);
    assert.ok(!(await r.text()).includes(SECRET));
  }
});

test("with valid launch information the same process becomes ready, and the routes redirect", async () => {
  process.env.STYLE_PRIVACY_URL = "https://style.example.com/privacy";
  process.env.STYLE_TERMS_URL = "https://style.example.com/terms";
  process.env.STYLE_SUPPORT_URL = "mailto:support@style.example.com";
  const response = await health();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
  assert.equal(launchResponse("privacy").status, 307);
  assert.equal(launchResponse("terms").status, 307);
  assert.equal(launchResponse("support").status, 200, "a mailto: support destination is the contact page, not a redirect");
  assert.equal(existsSync(dir), true);
});

// ------------------------------------------------------------------ documentation

test("the operator guide, env examples and notes document the three variables and do not claim legal adequacy or readiness", () => {
  const guide = read("docs/DEPLOYMENT.md");
  for (const name of Object.values(LAUNCH_ENV)) {
    assert.ok(guide.includes(`\`${name}\``), `${name} in the guide`);
    assert.ok(read(".env.example").includes(name), `${name} in .env.example`);
    assert.ok(read(".env.compose.example").includes(name), `${name} in .env.compose.example`);
  }
  assert.match(guide, /## Launch information: privacy notice, terms and support \(build 032\)/);
  assert.match(guide, /`\/privacy`, `\/terms` and `\/support`/);
  assert.match(guide, /\{"ready":false\}/);
  assert.match(guide, /mailto:/);
  assert.match(guide, /\.env\.production/);
  assert.match(guide, /do \*\*not\*\* make the documents adequate/);
  assert.match(guide, /Operator identity, jurisdiction, legal review and actual monitored support remain launch blockers/);

  const notes = read("docs/reviews/implementation-032-notes.md");
  for (const re of [/ico\.org\.uk/, /oag\.ca\.gov\/privacy\/ccpa/, /not legal advice/i, /not launch-ready/i, /operator identity/i, /jurisdiction/i, /legal review/i, /monitored support/i, /hosting/i, /domain/i, /TLS/, /SMTP/, /off-server/i, /capacity/i, /rights-cleared/i, /single-item/i])
    assert.match(notes, re, String(re));
  for (const f of ["docs/DEPLOYMENT.md", "docs/reviews/implementation-032-notes.md"])
    for (const l of read(f).split("\n"))
      if (/ready to launch|launch[- ]ready|launch readiness|production[- ]ready|legally (compliant|adequate)|GDPR[- ]compliant|CCPA[- ]compliant/i.test(l)) assert.match(l, /no claim|not |never|cannot|until|remain|open|unverified|without/i, `${f}: ${l.slice(0, 120)}`);
});
