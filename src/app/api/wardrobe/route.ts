import { NextRequest, NextResponse } from "next/server";
import {
  account,
  readJson,
  errorResponse,
  privateHeaders,
} from "../../../server/access";
import {
  commitWardrobeSave,
  prepareWardrobeSave,
  readWardrobeAsync,
  reclaimAfterRead,
} from "../../../server/wardrobes";
import { runWriteTransaction } from "../../../server/writeTransaction";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    const user = await account(req);
    // Read first: no write gate and no BEGIN IMMEDIATE. Only when the read saw
    // an expired photo that nothing references does a separate, bounded write
    // run, and that write re-reads the current wardrobe itself. Its outcome
    // never changes this response.
    const { wardrobe, reclaimable } = await readWardrobeAsync(
      user.id,
      user.name,
    );
    if (reclaimable) await reclaimAfterRead(user.id);
    return NextResponse.json(wardrobe, { headers: privateHeaders });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PUT(req: NextRequest) {
  try {
    // Order kept: origin, session, account binding and the change quota run
    // BEFORE the body is read, so a request that later times out has already
    // used one slot of the 120-per-minute counter (it is not refunded). The
    // body read itself is bounded by limits().bodyReadTimeoutMs (readJson's
    // default), and a timeout answers 408 before saveWardrobe or any wardrobe
    // write runs.
    const user = await account(req, true);
    const body = await readJson(req, undefined, { route: "wardrobe" });
    // Pure validation, reference enumeration and serialization happen before
    // the write gate is requested. Everything that depends on database state
    // (photo ownership, revision, idempotent acknowledgement, the write and
    // reclamation) is decided inside the one committing transaction below.
    const prepared = prepareWardrobeSave(body);
    return NextResponse.json(
      await runWriteTransaction(() => commitWardrobeSave(user.id, prepared)),
      { headers: privateHeaders },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
