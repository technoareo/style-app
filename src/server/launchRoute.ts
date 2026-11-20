import { LAUNCH_LABEL, launchDestination, type LaunchKind } from "./launchInfo";

/**
 * The request handler behind /privacy, /terms and /support (build 032). The destination comes ONLY from the
 * validated operator configuration, read at request time; nothing in the request (path, query, headers, Host)
 * is ever used to build the Location or the page, so these routes cannot be an open redirect. A missing or
 * invalid configuration gets one fixed, non-indexable, uncacheable page that says nothing about the configured
 * value.
 *
 * https destinations are answered with a 307 redirect. A mailto: support destination is NOT redirected to:
 * browsers may refuse a redirect to a non-http(s) scheme as unsafe, so /support instead returns a fixed-structure
 * 200 page with one plain contact link.
 */

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

const HTML_HEADERS = {
  ...COMMON_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  // nothing is loaded or submitted from these pages; the mailto: link is an ordinary navigation
  "Content-Security-Policy": "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'",
} as const;

const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">`;

/** Escapes text for an HTML attribute value or text node. The validated address cannot contain markup, this is defence in depth. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Fixed unavailable page: no configuration value, no operator identity, no legal wording. */
export function unavailableResponse(kind: LaunchKind): Response {
  const label = LAUNCH_LABEL[kind];
  const body = `${HEAD}<title>Not available</title></head><body><main><h1>Not available</h1><p>The ${label} for this service is not available right now. Please try again later.</p></main></body></html>`;
  return new Response(body, { status: 503, headers: HTML_HEADERS });
}

/**
 * The support page for a mailto: destination: fixed structure, one clearly labelled plain link. `address` must
 * already be a validated `mailto:` destination from launchDestination(); it is escaped again before it is placed in
 * the href and in the readable text.
 */
export function supportMailtoResponse(mailto: string): Response {
  const address = escapeHtml(mailto.replace(/^mailto:/i, ""));
  const body = `${HEAD}<title>Support</title></head><body><main><h1>Support</h1><p>To contact support, email:</p><p><a href="mailto:${address}">${address}</a></p></main></body></html>`;
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

export function launchResponse(kind: LaunchKind, env: Record<string, string | undefined> = process.env): Response {
  const destination = launchDestination(kind, env);
  if (!destination) return unavailableResponse(kind);
  if (destination.startsWith("mailto:")) return supportMailtoResponse(destination);
  // 307: temporary, so a browser or proxy does not cache a destination the operator may change
  return new Response(null, { status: 307, headers: { ...COMMON_HEADERS, Location: destination } });
}
