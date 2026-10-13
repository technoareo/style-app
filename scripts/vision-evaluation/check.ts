/** Small strict-validation helpers. Every schema in this folder rejects unknown fields. */

export const SHA256_RE = /^[0-9a-fA-F]{64}$/;
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A bare file name: no directory separators, so a manifest cannot point outside the images folder. */
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export function isIsoTimestamp(v: unknown): v is string {
  return typeof v === "string" && TIMESTAMP_RE.test(v) && Number.isFinite(Date.parse(v));
}

export function isIsoDateOrTimestamp(v: unknown): v is string {
  return (typeof v === "string" && DATE_RE.test(v) && Number.isFinite(Date.parse(v))) || isIsoTimestamp(v);
}

export function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

/** Exactly these keys: a missing key and an extra key are both problems (null is how a value is "absent"). */
export function expectKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  at: string,
  out: string[],
): void {
  for (const k of keys) if (!(k in obj)) out.push(`${at}: missing field "${k}"`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) out.push(`${at}: unknown field "${k}"`);
}

/** Case-insensitive, trimmed comparison used for gold attribute values. */
export const normalizeText = (s: string) => s.trim().toLowerCase();
