import { NextRequest, NextResponse } from "next/server";
import { account, errorResponse, privateHeaders } from "../../../server/access";
import { listJobsForOwner } from "../../../server/analysisJobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner-only discovery of the caller's active and recent analysis jobs, so a
 * reload, a new tab or a later sign-in can resume or discard them. The owner
 * is always taken from the verified session, never from the request.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await account(req);
    return NextResponse.json(
      { jobs: listJobsForOwner(user.id) },
      { headers: privateHeaders },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
