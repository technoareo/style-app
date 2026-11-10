import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Pure logic of the operator-owned real-model browser verifier (build 028). The driver in
 * verify-browser-vision.ts only wires these functions to Playwright, so everything that can be wrong without a
 * browser or a model is tested in tests/browserVisionVerifier028.test.ts.
 *
 * This verifier checks that the real upload -> detect -> review -> save -> reload flow WORKS with the model the
 * operator configured. It is not a recognition benchmark and its evidence never claims accuracy.
 */

export const DEFAULT_APP_URL = "http://127.0.0.1:3000";
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 250_000;

// ----------------------------------------------------------------------------- configuration

/** APP_URL as an origin. Only http(s), no credentials, no path, query or fragment: a typo is refused, not guessed. */
export function resolveAppUrl(raw: string | undefined): string {
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_APP_URL : raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_URL is not a valid URL (expected something like http://127.0.0.1:3000)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("APP_URL must be an http or https URL");
  if (url.username || url.password) throw new Error("APP_URL must not contain credentials");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("APP_URL must be an origin only (no path, query or fragment)");
  return url.origin;
}

/** VERIFY_ANALYSIS_TIMEOUT_MS: whole milliseconds from 5000 to 900000; anything else is refused. */
export function parseAnalysisTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ANALYSIS_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) throw new Error("VERIFY_ANALYSIS_TIMEOUT_MS must be whole milliseconds");
  const n = Number(raw.trim());
  if (n < 5000 || n > 900_000) throw new Error("VERIFY_ANALYSIS_TIMEOUT_MS must be from 5000 to 900000");
  return n;
}

// ----------------------------------------------------------------------------- what the page says

/** "Review 1 detected item" / "Review 3 detected items": the count, or null when the text is not that heading. */
export function reviewHeadingCount(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const m = /^Review (\d+) detected (items?)$/.exec(text.replace(/\s+/g, " ").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  // the product pluralizes correctly; a heading that does not agree with its own number is not the heading
  return (n === 1) === (m[2] === "item") ? n : null;
}

/** A regular expression Playwright can use as an accessible name for the review heading, singular or plural. */
export const REVIEW_HEADING_NAME = /^Review \d+ detected items?$/;

/** The accessible name of the confirm button for `count` items ("Add 1 item to my wardrobe"). */
export function addButtonName(count: number): RegExp {
  return new RegExp(`^Add ${count} ${count === 1 ? "item" : "items"} to my wardrobe$`);
}

/** Product alert text, whitespace-collapsed and bounded, so evidence stays small and cannot carry a payload. */
export function sanitizeAlert(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}

export type PageReading = { heading: string | null; alert: string | null };
export type Outcome = { kind: "review"; count: number; elapsedMs: number } | { kind: "alert"; text: string; elapsedMs: number } | { kind: "timeout"; elapsedMs: number };

/**
 * Polls the page until the review heading appears (success), a product alert appears (fail quickly, with the
 * alert text) or the timeout passes. The heading wins over an alert seen in the same reading. `read` and the
 * clock are injected so the logic is tested without a browser.
 */
export async function pollOutcome(
  read: () => Promise<PageReading>,
  options: { timeoutMs: number; intervalMs?: number; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<Outcome> {
  const start = options.now();
  const interval = options.intervalMs ?? 500;
  for (;;) {
    const reading = await read();
    const elapsedMs = options.now() - start;
    const count = reviewHeadingCount(reading.heading);
    if (count !== null) return { kind: "review", count, elapsedMs };
    const alert = sanitizeAlert(reading.alert);
    if (alert !== "") return { kind: "alert", text: alert, elapsedMs };
    if (elapsedMs >= options.timeoutMs) return { kind: "timeout", elapsedMs };
    await options.sleep(interval);
  }
}

// ----------------------------------------------------------------------------- evidence

export type ModelEvidence = {
  configuredModel: string | null;
  /** The runtime's own digest of the installed model; null when it could not be obtained locally. */
  modelDigest: string | null;
  digestNote: string;
  request: { mode: string; promptSha256: string; requestSha256: string } | null;
};

export type ModelDeps = {
  configuredModel: () => { ok: true; name: string } | { ok: false };
  requestIdentity: () => { mode: string; promptSha256: string; requestSha256: string };
  ollamaUrl: () => string;
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
};

/** Model name, Ollama digest and request identity: hashes and names only, never prompts' text, keys or paths. */
export async function collectModelEvidence(deps: ModelDeps): Promise<ModelEvidence> {
  const model = deps.configuredModel();
  let request: ModelEvidence["request"] = null;
  try {
    const r = deps.requestIdentity();
    request = { mode: r.mode, promptSha256: r.promptSha256, requestSha256: r.requestSha256 };
  } catch {
    request = null;
  }
  if (!model.ok) return { configuredModel: null, modelDigest: null, digestNote: "VISION_MODEL is not a valid model name", request };
  let digest: string | null = null;
  let note = "digest not obtainable: Ollama did not answer";
  try {
    const response = await deps.fetch(`${deps.ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const body = (await response.json()) as { models?: Array<{ name?: unknown; digest?: unknown }> };
      const wanted = model.name.includes(":") ? model.name : `${model.name}:latest`;
      const found = body.models?.find((m) => m.name === model.name || m.name === wanted);
      if (found && typeof found.digest === "string" && /^[0-9a-f]{12,128}$/i.test(found.digest)) {
        digest = found.digest.toLowerCase();
        note = "digest reported by the local Ollama runtime";
      } else note = "digest not obtainable: the configured model was not listed with a digest";
    }
  } catch {
    /* keep the note: a missing digest never fails the verification */
  }
  return { configuredModel: model.name, modelDigest: digest, digestNote: note, request };
}

export const EVIDENCE_CHECKS = [
  "app reachable",
  "disposable account signed in",
  "photo upload accepted (browser normalization)",
  "real model analysis completed",
  "review heading shown",
  "review confirmed and saved",
  "reload persistence",
] as const;

export type Evidence = {
  schemaVersion: 1;
  kind: "live-browser-verification";
  passed: boolean;
  startedAt: string;
  elapsedSeconds: number;
  appOrigin: string;
  model: ModelEvidence;
  detectedItemCount: number | null;
  completedChecks: string[];
  failedStep: string | null;
  failureReason: string | null;
  productAlert: string | null;
  screenshots: string[];
  scope: "single-item flow only; crowded photos are out of scope";
  note: "This is a flow check with one public photo. It measures no recognition accuracy and is not a benchmark.";
};

export function buildEvidence(input: Omit<Evidence, "schemaVersion" | "kind" | "scope" | "note" | "elapsedSeconds"> & { elapsedMs: number }): Evidence {
  const { elapsedMs, ...rest } = input;
  return {
    schemaVersion: 1,
    kind: "live-browser-verification",
    ...rest,
    elapsedSeconds: Math.round(elapsedMs / 100) / 10,
    productAlert: rest.productAlert === null ? null : sanitizeAlert(rest.productAlert),
    failureReason: rest.failureReason === null ? null : sanitizeAlert(rest.failureReason),
    scope: "single-item flow only; crowded photos are out of scope",
    note: "This is a flow check with one public photo. It measures no recognition accuracy and is not a benchmark.",
  };
}

const FORBIDDEN_KEYS = /password|passwd|secret|token|cookie|credential|authorization|apikey|api_key|email|dataurl|base64/i;

/**
 * Refuses evidence that could carry something sensitive: a credential-like key, a data URI, a long base64-looking
 * run, an e-mail address, or a runtime data directory path. Returns the problems (empty when safe).
 */
export function evidenceProblems(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      if (/data:[a-z]+\/[a-z0-9.+-]+;base64/i.test(v) || /[A-Za-z0-9+/]{200,}={0,2}/.test(v)) out.push(`${at}: looks like embedded base64 data`);
      if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(v)) out.push(`${at}: contains an e-mail address`);
      if (/(^|[\\/])\.data([\\/]|$)|\.runtime|STYLE_DATA_DIR/i.test(v)) out.push(`${at}: mentions a runtime data directory`);
      if (v.length > 400) out.push(`${at}: unexpectedly long text`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.test(k)) out.push(`${at}.${k}: a key that could hold a credential or personal data`);
        walk(x, `${at}.${k}`);
      }
  };
  walk(value, "evidence");
  return out;
}

/** `20261110T093045Z` from a Date, for file names. */
export const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/**
 * Writes `bytes` to a NEW file `<base>.<ext>` in `dir`, or `<base>-2.<ext>`, `-3` ... if the name is taken. The
 * file is created exclusively (flag "wx"), so a prior run's evidence is never overwritten even if two verifiers
 * race. Returns the file name (not the path).
 */
export function writeEvidenceFile(dir: string, base: string, ext: string, bytes: Uint8Array | string, exists: (p: string) => boolean = existsSync): string {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= 1000; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
    if (exists(path.join(dir, name))) continue;
    try {
      writeFileSync(path.join(dir, name), bytes, { flag: "wx" });
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error("could not find a free evidence file name");
}
