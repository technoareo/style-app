import { NextRequest, NextResponse } from "next/server";
import {
  account,
  errorResponse,
  privateHeaders,
} from "../../../../server/access";
import {
  getAnalysisJobForOwner,
  cancelAnalysisJobForOwner,
} from "../../../../server/analysisJobs";
import { runWriteTransaction } from "../../../../server/writeTransaction";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await account(req);
    const { id } = await params;
    const job = await runWriteTransaction(() =>
      getAnalysisJobForOwner(user.id, id),
    );
    return NextResponse.json(job, { headers: privateHeaders });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Cancel/discard stays available when the ordinary change quota is used
    // up; origin, session and account binding are still enforced.
    const user = await account(req, true, { quota: false });
    const { id } = await params;
    const job = await runWriteTransaction(() =>
      cancelAnalysisJobForOwner(user.id, id),
    );
    return NextResponse.json(job, { headers: privateHeaders });
  } catch (e) {
    return errorResponse(e);
  }
}
