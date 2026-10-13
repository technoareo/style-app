import { NextRequest, NextResponse } from "next/server";
import {
  account,
  errorResponse,
  privateHeaders,
  RequestError,
} from "../../../server/access";
import {
  normalizePhoto,
  isModelAvailable,
  VisionError,
} from "../../../server/vision";
import {
  analysisCapacity,
  enqueueAnalysisJob,
  isWorkerHeartbeatRecent,
  precheckAnalysisAdmission,
} from "../../../server/analysisJobs";
import { withAccountImageWork } from "../../../server/admission";
import {
  assertDeclaredLength,
  readUploadRequest,
} from "../../../server/imageAdmission";
import { limits } from "../../../server/limits";
import { runWriteTransaction } from "../../../server/writeTransaction";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await account(req);
    const modelReady = await isModelAvailable();
    const configured = modelReady && isWorkerHeartbeatRecent();
    return NextResponse.json(
      { configured, capacity: analysisCapacity(user.id) },
      { headers: privateHeaders },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    // 1. Identity, origin, account binding, change quota.
    const user = await account(req, true);
    // 2. Cheap, read-only admission (active job, queue depth, wait budget,
    //    daily limits) and declared size, before any body is read or decoded.
    precheckAnalysisAdmission(user.id);
    assertDeclaredLength(req);
    // 3. Body read, header inspection and decode share a few process-wide
    //    slots. The slot is released before any database write is attempted.
    //    One such work per account at a time, shared with /api/photos: a
    //    second one is refused (429) before it can take a slot.
    const canonical = await withAccountImageWork(
      user.id,
      "analyze",
      async () => {
        const { bytes } = await readUploadRequest(
          req,
          (body) => {
            if (body.consent !== true)
              throw new RequestError(
                400,
                "Please allow photo analysis before uploading.",
              );
          },
          "analyze",
        );
        try {
          return await normalizePhoto(bytes, limits().maxUploadPixels);
        } catch (e) {
          if (e instanceof VisionError) throw new RequestError(400, e.message);
          throw e;
        }
      },
      req.signal,
    );
    // 4. Atomic re-check and enqueue in one write transaction.
    const job = await runWriteTransaction(() =>
      enqueueAnalysisJob(user.id, canonical),
    );
    return NextResponse.json(job, { status: 202, headers: privateHeaders });
  } catch (e) {
    return errorResponse(e);
  }
}
