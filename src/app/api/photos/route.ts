import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import {
  account,
  errorResponse,
  RequestError,
  privateHeaders,
} from "../../../server/access";
import { withAccountImageWork } from "../../../server/admission";
import {
  assertDeclaredLength,
  readUploadRequest,
} from "../../../server/imageAdmission";
import { getDatabase } from "../../../server/database";
import { limits } from "../../../server/limits";
import { runWriteTransaction } from "../../../server/writeTransaction";
export const runtime = "nodejs";

const ACCOUNT_PHOTO_BYTES = 100_000_000;
const TOTAL_PHOTO_BYTES = 2_000_000_000;
const ACCOUNT_PHOTO_COUNT = 2000;

/**
 * Cheap read-only storage check run before the body is read or decoded. The
 * authoritative, atomic check stays in the write transaction below; a
 * duplicate of an existing photo is deduplicated there even when an account is
 * exactly at its cap, which this pre-check conservatively refuses.
 */
function precheckStorage(userId: string): void {
  const db = getDatabase();
  const mine = db
    .prepare(
      "SELECT coalesce(sum(length(data)),0) AS bytes, count(*) AS total FROM photo_assets WHERE user_id=?",
    )
    .get(userId) as { bytes: number; total: number };
  if (mine.bytes >= ACCOUNT_PHOTO_BYTES)
    throw new RequestError(
      413,
      "Your photo storage is full. Export a backup and remove unused items.",
    );
  if (mine.total >= ACCOUNT_PHOTO_COUNT)
    throw new RequestError(
      413,
      "Your account has reached its photo limit. Remove unused items and looks before adding more.",
    );
  const total = db
    .prepare("SELECT coalesce(sum(length(data)),0) AS bytes FROM photo_assets")
    .get() as { bytes: number };
  if (total.bytes >= TOTAL_PHOTO_BYTES)
    throw new RequestError(
      503,
      "Photo storage is at capacity. Please try again later.",
      { retryAfterSeconds: 300 },
    );
}

export async function POST(req: NextRequest) {
  try {
    const user = await account(req, true);
    precheckStorage(user.id);
    assertDeclaredLength(req);
    // Body read, header inspection and decode hold a shared image-work slot;
    // it is released before the database write below. One such work per
    // account at a time, shared with /api/analyze: a second one is refused
    // (429) before it can take a slot.
    const photo = await withAccountImageWork(
      user.id,
      "photos",
      async () => {
        const { bytes } = await readUploadRequest(req, undefined, "photos");
        try {
          return await sharp(bytes, { limitInputPixels: limits().maxUploadPixels })
            .rotate()
            .flatten({ background: "#fff" })
            .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch {
          throw new RequestError(400, "This photo could not be read.");
        }
      },
      req.signal,
    );
    const sha = createHash("sha256").update(photo).digest("hex");
    const id = await runWriteTransaction((db) => {
      let id: string;
      const existing = db
        .prepare("SELECT id FROM photo_assets WHERE user_id=? AND sha256=?")
        .get(user.id, sha) as { id: string } | undefined;
      if (existing) id = existing.id;
      else {
        const usage = db
          .prepare(
            "SELECT coalesce(sum(length(data)),0) AS bytes FROM photo_assets WHERE user_id=?",
          )
          .get(user.id) as { bytes: number };
        if (usage.bytes + photo.length > ACCOUNT_PHOTO_BYTES)
          throw new RequestError(
            413,
            "Your photo storage is full. Export a backup and remove unused items.",
          );
        const total = db
          .prepare(
            "SELECT coalesce(sum(length(data)),0) AS bytes FROM photo_assets",
          )
          .get() as { bytes: number };
        if (total.bytes + photo.length > TOTAL_PHOTO_BYTES)
          throw new RequestError(
            503,
            "Photo storage is at capacity. Please try again later.",
            { retryAfterSeconds: 300 },
          );
        const count = db
          .prepare("SELECT count(*) AS total FROM photo_assets WHERE user_id=?")
          .get(user.id) as { total: number };
        if (count.total >= ACCOUNT_PHOTO_COUNT)
          throw new RequestError(
            413,
            "Your account has reached its photo limit. Remove unused items and looks before adding more.",
          );
        id = randomUUID();
        db.prepare(
          "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
        ).run(id, user.id, photo, sha, Date.now());
      }
      return id;
    });
    return NextResponse.json(
      { image: `/api/photos/${id}`, sha256: sha },
      { headers: privateHeaders },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
