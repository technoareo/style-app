import { launchResponse } from "../../server/launchRoute";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same-origin stable link; redirects to the operator's validated STYLE_TERMS_URL (see src/server/launchInfo.ts). */
export function GET() {
  return launchResponse("terms");
}
