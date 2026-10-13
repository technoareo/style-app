import { NextRequest, NextResponse } from "next/server";
import {
  account,
  errorResponse,
  privateHeaders,
  RequestError,
} from "../../../../server/access";
import { getDatabase } from "../../../../server/database";
export const runtime = "nodejs";
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await account(req);
    const { id } = await params;
    const row = getDatabase()
      .prepare("SELECT data FROM photo_assets WHERE id=? AND user_id=?")
      .get(id, user.id) as { data: Uint8Array } | undefined;
    if (!row) throw new RequestError(404, "Photo not found.");
    return new NextResponse(new Uint8Array(row.data), {
      headers: {
        ...privateHeaders,
        "Content-Type": "image/jpeg",
        "Content-Disposition": "inline",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
