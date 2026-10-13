import { NextResponse } from "next/server";
import { accountImageWorkActive, imageWorkStats } from "../../../../server/admission";
import { uploadMetrics } from "../../../../server/uploadMetrics";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload-path counters for an operator or a probe (build 013). Aggregate
 * integers only: global image slots (active / queued / refused), how many
 * accounts hold an in-flight upload (a count, never an id), and per fixed
 * route (auth, wardrobe, photos, analyze, other) how request bodies ended,
 * how the stream cancel ended after an early exit (settled / rejected /
 * grace_expired) and how often per-account admission refused a second upload.
 * No user id, address, header, body or error text is recorded or returned, and
 * no request parameter changes what is shown. It calls neither the database nor
 * the auth setup, so it answers even when those are unavailable. Counters are
 * per process and start again at zero on restart.
 *
 * Reachability: this is an unauthenticated route like /api/health. If the
 * deployment should not publish these totals, block /api/health/uploads at the
 * proxy; the application does not depend on it.
 */
export async function GET() {
  return NextResponse.json(
    {
      images: imageWorkStats(),
      accountsHoldingUpload: accountImageWorkActive(),
      ...uploadMetrics(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
