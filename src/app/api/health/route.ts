import { NextResponse } from "next/server";
import { getReadyAuth } from "../../../server/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await getReadyAuth();
    return NextResponse.json(
      { ready: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ready: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
