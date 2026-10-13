/**
 * Bounded, numeric-only counters for the upload path (build 013).
 *
 * What they are for: letting an operator (or root's probe) OBSERVE, from the
 * server side, what actually happened to request bodies and per-account upload
 * admission: how bodies ended, whether the stream's own cancel() settled or the
 * grace period expired, and how often a second upload from the same account
 * was refused.
 *
 * Bounds and privacy, all structural:
 *  - the label sets are closed and fixed here (routes, outcomes); a value that
 *    is not in a set is counted under "other" / ignored, so no caller can grow
 *    the table;
 *  - the only stored data are integers. No user id, e-mail, IP address, header,
 *    body, path with an id, error text or request flag is ever recorded;
 *  - the whole table is a few dozen numbers (5 routes x ~15 counters).
 *
 * This is a leaf module (it imports nothing from the app) so any server module
 * can report to it without creating an import cycle. State lives on globalThis
 * because Next bundles each route separately.
 */

export const UPLOAD_ROUTES = [
  "auth",
  "wardrobe",
  "photos",
  "analyze",
  "other",
] as const;
export type UploadRoute = (typeof UPLOAD_ROUTES)[number];

/** How a bounded body read ended. "error" is a genuine stream error. */
export const BODY_OUTCOMES = [
  "ok",
  "empty",
  "timeout",
  "aborted",
  "too_large",
  "error",
] as const;
export type BodyOutcome = (typeof BODY_OUTCOMES)[number];

/**
 * What happened to the stream's own cancel() after an early exit:
 * settled (resolved in time), rejected (rejected in time; swallowed), or
 * grace_expired (did not settle within the grace period; we moved on).
 */
export const CANCEL_OUTCOMES = ["settled", "rejected", "grace_expired"] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];

/** Per-account upload admission (photos and analyze share one rule). */
export const ACCOUNT_EVENTS = ["admitted", "refused", "released"] as const;
export type AccountEvent = (typeof ACCOUNT_EVENTS)[number];

type Table = Record<UploadRoute, number[]>;
type State = { body: Table; cancel: Table; account: Table };
const KEY = Symbol.for("style-studio.upload-metrics");

const table = (width: number): Table =>
  Object.fromEntries(
    UPLOAD_ROUTES.map((route) => [route, new Array<number>(width).fill(0)]),
  ) as Table;

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= {
    body: table(BODY_OUTCOMES.length),
    cancel: table(CANCEL_OUTCOMES.length),
    account: table(ACCOUNT_EVENTS.length),
  });
}

/** Any label outside the closed set is counted as "other". */
export function normalizeRoute(route: unknown): UploadRoute {
  return (UPLOAD_ROUTES as readonly unknown[]).includes(route)
    ? (route as UploadRoute)
    : "other";
}

function bump<T extends string>(
  counters: Table,
  names: readonly T[],
  route: unknown,
  name: T,
): void {
  const index = names.indexOf(name);
  if (index < 0) return;
  counters[normalizeRoute(route)][index]++;
}

export const countBody = (route: unknown, outcome: BodyOutcome) =>
  bump(state().body, BODY_OUTCOMES, route, outcome);
export const countCancel = (route: unknown, outcome: CancelOutcome) =>
  bump(state().cancel, CANCEL_OUTCOMES, route, outcome);
export const countAccount = (route: unknown, event: AccountEvent) =>
  bump(state().account, ACCOUNT_EVENTS, route, event);

function view<T extends string>(counters: Table, names: readonly T[]) {
  const out = {} as Record<UploadRoute, Record<T, number>>;
  for (const route of UPLOAD_ROUTES) {
    const row = {} as Record<T, number>;
    names.forEach((name, i) => (row[name] = counters[route][i]));
    out[route] = row;
  }
  return out;
}

/** A plain-number copy of every counter (safe to serialize as is). */
export function uploadMetrics() {
  const s = state();
  return {
    bodies: view(s.body, BODY_OUTCOMES),
    cancels: view(s.cancel, CANCEL_OUTCOMES),
    accounts: view(s.account, ACCOUNT_EVENTS),
  };
}

/** Test helper: zeroes every counter in place. */
export function resetUploadMetrics(): void {
  const s = state();
  for (const t of [s.body, s.cancel, s.account])
    for (const route of UPLOAD_ROUTES) t[route].fill(0);
}
