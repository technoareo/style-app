import { launchResponse } from "../../server/launchRoute";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin stable link. An https STYLE_SUPPORT_URL gets a 307 redirect; a mailto: address gets a fixed 200 contact
 * page instead (browsers may refuse a redirect to mailto:). See src/server/launchRoute.ts and launchInfo.ts.
 */
export function GET() {
  return launchResponse("support");
}
