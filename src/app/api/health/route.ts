import { NextResponse } from "next/server";
import { getReadyAuth } from "../../../server/auth";
import { mainConnectionUnusable } from "../../../server/database";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_READY = () =>
  NextResponse.json(
    { ready: false },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

export async function GET() {
  try {
    await getReadyAuth();
    // getReadyAuth() is memoised and never looks at the database again, so it
    // cannot notice a main connection that was quarantined and could not be
    // closed. That state refuses every later write until the process restarts:
    // report it with the same fixed body, never a reason (this route is public).
    if (mainConnectionUnusable()) return NOT_READY();
    return NextResponse.json(
      { ready: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NOT_READY();
  }
}
