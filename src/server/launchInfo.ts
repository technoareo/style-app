/**
 * Launch information (build 032): where the operator publishes the three things people need to find at the point
 * an account is created and a photo is used: the PRIVACY NOTICE, the TERMS, and a way to get SUPPORT.
 *
 * This is an engineering guard, not a legal document. The repository ships no policy text and no operator
 * identity; the operator supplies three destinations at runtime:
 *
 *   STYLE_PRIVACY_URL   absolute https URL
 *   STYLE_TERMS_URL     absolute https URL
 *   STYLE_SUPPORT_URL   absolute https URL, or a single mailto: address
 *
 * In a PUBLIC deployment (STYLE_PUBLIC_DEPLOYMENT=true) all three must be present and valid or the app does not
 * become ready. Parsing is strict and fail-closed: a bad value yields the fixed result `{ ok: false }`; it is
 * never echoed, logged or placed in an error message. Values are read at request time (never NEXT_PUBLIC_*,
 * which would be baked in at build time and could not follow Compose configuration).
 *
 * Server-only: this module reads process.env and must not be imported by a client component.
 */

export const LAUNCH_KINDS = ["privacy", "terms", "support"] as const;
export type LaunchKind = (typeof LAUNCH_KINDS)[number];

export const LAUNCH_ENV: Readonly<Record<LaunchKind, string>> = {
  privacy: "STYLE_PRIVACY_URL",
  terms: "STYLE_TERMS_URL",
  support: "STYLE_SUPPORT_URL",
};

/** The stable same-origin paths the UI links to. They redirect to the validated destinations. */
export const LAUNCH_PATH: Readonly<Record<LaunchKind, string>> = {
  privacy: "/privacy",
  terms: "/terms",
  support: "/support",
};

/** Words the unavailable page may use for each kind (fixed, never derived from configuration). */
export const LAUNCH_LABEL: Readonly<Record<LaunchKind, string>> = {
  privacy: "privacy information",
  terms: "terms",
  support: "support contact",
};

export type Destination = { ok: true; url: string } | { ok: false };
const FAILED: Destination = { ok: false };

const MAX_LENGTH = 2048;

/** Host suffixes that can never be a public destination (and reserved names that are never real sites). */
const NON_PUBLIC_SUFFIXES = ["localhost", "local", "internal", "localdomain", "lan", "home.arpa", "test", "invalid", "example"] as const;

/**
 * Conservative rule for a PUBLIC host: a name with at least one dot, made of ordinary DNS labels, a letters-only
 * (or punycode) final label, no trailing dot, no IP literal of any form, nothing that ends in a non-public
 * suffix. Stricter than the APP_URL check (which only refuses a few loopback names) on purpose: these links are
 * shown to every visitor. It does not and cannot prove the host is the operator's or that it resolves.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "" || host.length > 253 || host.endsWith(".")) return false;
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false; // also rejects 127.0.0.1 and any numeric tail
  for (const suffix of NON_PUBLIC_SUFFIXES) if (host === suffix || host.endsWith(`.${suffix}`)) return false;
  return true;
}

/** A single plain mail address, no display name, no list, no header parameters. */
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=^_`{|}~-]{1,64}@([A-Za-z0-9.-]{1,253})$/;

function mailtoDestination(raw: string, publicDeployment: boolean): Destination {
  if (!/^mailto:/i.test(raw)) return FAILED;
  const rest = raw.slice("mailto:".length);
  if (rest.includes("?") || rest.includes("%") || rest.includes(",") || rest.includes(";") || rest.includes("<")) return FAILED;
  const m = MAILBOX.exec(rest);
  if (!m) return FAILED;
  const local = rest.slice(0, rest.indexOf("@"));
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return FAILED;
  if (publicDeployment && !isPublicHostname(m[1])) return FAILED;
  if (!publicDeployment && (m[1].startsWith(".") || m[1].endsWith(".") || m[1].includes(".."))) return FAILED;
  return { ok: true, url: `mailto:${rest}` };
}

/**
 * Parses one operator-supplied destination. Returns `{ ok: false }` for anything that is not exactly acceptable and
 * never reveals why or what the value was. Accepted (public deployment): an absolute https URL on a public host with
 * no credentials, fragment, port, control character or whitespace, already in canonical form (what `new URL` would
 * print); support may also be a single mailto: address on a public host. Local development additionally accepts http
 * and internal hosts so the links can be tried on a laptop, with every other rule unchanged.
 */
export function parseLaunchUrl(kind: LaunchKind, value: unknown, publicDeployment: boolean): Destination {
  if (typeof value !== "string") return FAILED;
  const raw = value.trim();
  if (raw === "" || raw.length > MAX_LENGTH) return FAILED;
  // printable ASCII only, no space: rejects control characters, newlines, tabs, bidi/zero-width characters and raw
  // non-ASCII hosts (an operator writes the punycode form)
  if (!/^[\x21-\x7e]+$/.test(raw)) return FAILED;
  if (raw.includes("#") || raw.includes("\\")) return FAILED;
  if (kind === "support" && /^mailto:/i.test(raw)) return mailtoDestination(raw, publicDeployment);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return FAILED;
  }
  if (url.protocol !== "https:" && !(!publicDeployment && url.protocol === "http:")) return FAILED;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return FAILED;
  if (/@/.test(raw.replace(/^[a-z]+:\/\//i, "").split(/[/?]/)[0])) return FAILED; // credentials, even an empty `@`
  // canonical only: `new URL` prints exactly this; a bare origin may omit the trailing slash
  if (url.href !== raw && url.href !== `${raw}/`) return FAILED;
  if (publicDeployment) {
    if (url.port !== "") return FAILED; // https://host:8443 is not a normal public page
    if (!isPublicHostname(url.hostname)) return FAILED;
  }
  return { ok: true, url: url.href };
}

export type LaunchInfo = {
  publicDeployment: boolean;
  destinations: Readonly<Record<LaunchKind, Destination>>;
  /** Kinds whose destination is missing or invalid. Names of OUR three kinds only, never a value. */
  missing: LaunchKind[];
  complete: boolean;
};

const isPublic = (env: Record<string, string | undefined>) => env.STYLE_PUBLIC_DEPLOYMENT === "true";

/** Resolves all three destinations from the environment at call time. */
export function resolveLaunchInfo(env: Record<string, string | undefined> = process.env): LaunchInfo {
  const publicDeployment = isPublic(env);
  const destinations = Object.fromEntries(LAUNCH_KINDS.map((k) => [k, parseLaunchUrl(k, env[LAUNCH_ENV[k]], publicDeployment)])) as Record<LaunchKind, Destination>;
  const missing = LAUNCH_KINDS.filter((k) => !destinations[k].ok);
  return { publicDeployment, destinations, missing, complete: missing.length === 0 };
}

/** The validated destination for one kind, or null. Used by the redirect routes. */
export function launchDestination(kind: LaunchKind, env: Record<string, string | undefined> = process.env): string | null {
  const d = parseLaunchUrl(kind, env[LAUNCH_ENV[kind]], isPublic(env));
  return d.ok ? d.url : null;
}

/**
 * Fail-closed startup/readiness check. In a public deployment every destination must be valid; otherwise this
 * throws a fixed message that names only the variable NAMES (never a value). Outside a public deployment it
 * does nothing: a laptop without these settings still works and its links show the unavailable page.
 */
export function assertLaunchInfoConfigured(env: Record<string, string | undefined> = process.env): void {
  if (!isPublic(env)) return;
  const { missing } = resolveLaunchInfo(env);
  if (missing.length > 0)
    throw new Error(`Public deployment requires valid launch information: set ${missing.map((k) => LAUNCH_ENV[k]).join(", ")} (see docs/DEPLOYMENT.md).`);
}
