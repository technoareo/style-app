import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { waitForMail } from "./helpers/mailCapture";

test("verified accounts isolate wardrobes and photos, handle conflicts, recover and delete themselves", async () => {
  process.env.STYLE_DATA_DIR = path.join(
    process.cwd(),
    ".data",
    "tests",
    randomUUID(),
  );
  process.env.APP_URL = "http://127.0.0.1:3000";
  mkdirSync(process.env.STYLE_DATA_DIR, { recursive: true });
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const { GET, PUT } = await import("../src/app/api/wardrobe/route");
  const { POST: upload } = await import("../src/app/api/photos/route");
  const { GET: photo } = await import("../src/app/api/photos/[id]/route");
  const auth = await getReadyAuth();
  const origin = process.env.APP_URL;
  const password = "Correct wardrobe passphrase 42!";
  // Capture is eventual since build 008: poll for the message.
  const mail = (email: string, subject: string) =>
    waitForMail(process.env.STYLE_DATA_DIR!, email, subject);
  async function create(email: string) {
    const result = await auth.api.signUpEmail({
      body: { email, password, name: "Test wearer" },
    });
    await assert.rejects(auth.api.signInEmail({ body: { email, password } }));
    const url = new URL(
      (await mail(email, "Verify")).text.split(": ").slice(1).join(": "),
    );
    await auth.api.verifyEmail({
      query: { token: url.searchParams.get("token")! },
    });
    const response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { id: result.user.id, email, cookie };
  }
  const alice = await create("alice@example.test"),
    bob = await create("bob@example.test");
  function req(
    route: string,
    user?: typeof alice,
    body?: unknown,
    accountId = user?.id,
  ) {
    return new NextRequest(origin + route, {
      method: body ? "PUT" : "GET",
      headers: {
        origin,
        cookie: user?.cookie || "",
        "content-type": "application/json",
        "x-style-account": accountId || "",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  assert.equal((await GET(req("/api/wardrobe"))).status, 401);
  const bytes = readFileSync("tests/fixtures/public-shirt.jpg");
  const photoRequest = new NextRequest(origin + "/api/photos", {
    method: "POST",
    headers: {
      origin,
      cookie: alice.cookie,
      "content-type": "application/json",
      "x-style-account": alice.id,
    },
    body: JSON.stringify({
      image: "data:image/jpeg;base64," + bytes.toString("base64"),
    }),
  });
  const uploaded = await upload(photoRequest);
  assert.equal(uploaded.status, 200);
  const asset = await uploaded.json();
  const id = asset.image.split("/").at(-1);
  assert.equal(
    (await photo(req(asset.image, alice), { params: Promise.resolve({ id }) }))
      .status,
    200,
  );
  assert.equal(
    (await photo(req(asset.image, bob), { params: Promise.resolve({ id }) }))
      .status,
    404,
  );
  assert.equal(
    (await photo(req(asset.image), { params: Promise.resolve({ id }) })).status,
    401,
  );
  const garment = {
    id: "shirt",
    name: "White tee",
    category: "Tops",
    color: "white",
    brand: "",
    size: "",
    image: asset.image,
    reviewed: true,
  };
  const space = {
    version: 1,
    name: "Test wardrobe",
    wardrobe: [garment],
    looks: [],
    revision: 0,
  };
  assert.equal((await PUT(req("/api/wardrobe", alice, space))).status, 200);
  assert.equal(
    (await PUT(req("/api/wardrobe", alice, space))).status,
    200,
    "an identical retry safely acknowledges a committed write",
  );
  assert.equal(
    (
      await PUT(
        req("/api/wardrobe", alice, {
          ...space,
          wardrobe: [{ ...garment, name: "Stale alternative" }],
        }),
      )
    ).status,
    409,
  );
  assert.equal((await PUT(req("/api/wardrobe", bob, space))).status, 400);
  assert.equal(
    (await PUT(req("/api/wardrobe", bob, { ...space, wardrobe: [] }, alice.id)))
      .status,
    409,
  );
  assert.equal(
    (await (await GET(req("/api/wardrobe", bob))).json()).wardrobe.length,
    0,
  );
  assert.equal(
    (await (await GET(req("/api/wardrobe", alice))).json()).wardrobe[0].name,
    "White tee",
  );
  const database = getDatabase();
  database
    .prepare(
      "INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)",
    )
    .run("orphan", alice.id, bytes, "orphan-hash", Date.now() - 172800000);
  await GET(req("/api/wardrobe", alice));
  assert.equal(
    database.prepare("SELECT id FROM photo_assets WHERE id=?").get("orphan"),
    undefined,
  );
  assert.ok(
    database.prepare("SELECT id FROM photo_assets WHERE id=?").get(id),
    "referenced photos survive reclamation",
  );
  assert.equal(
    (
      await PUT(
        req("/api/wardrobe", alice, { ...space, wardrobe: [], revision: 1 }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await photo(req(asset.image, alice), { params: Promise.resolve({ id }) }))
      .status,
    404,
    "removing the last photo reference deletes the asset",
  );
  await auth.api.requestPasswordReset({
    body: { email: alice.email, redirectTo: origin + "/reset-password" },
  });
  const resetUrl = new URL(
    (await mail(alice.email, "Reset")).text.split(": ").slice(1).join(": "),
  );
  const token =
    resetUrl.searchParams.get("token") || resetUrl.pathname.split("/").at(-1)!;
  const newPassword = "Different wardrobe passphrase 91!";
  await auth.api.resetPassword({ body: { token, newPassword } });
  assert.equal((await GET(req("/api/wardrobe", alice))).status, 401);
  await assert.rejects(
    auth.api.resetPassword({ body: { token, newPassword } }),
  );
  await assert.rejects(
    auth.api.signInEmail({ body: { email: alice.email, password } }),
  );
  const newSession = await auth.api.signInEmail({
    body: { email: alice.email, password: newPassword },
    asResponse: true,
  });
  alice.cookie = newSession.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  await assert.rejects(
    auth.api.deleteUser({
      headers: new Headers({ cookie: alice.cookie }),
      body: { password },
    }),
  );
  await auth.api.deleteUser({
    headers: new Headers({ cookie: alice.cookie }),
    body: { password: newPassword },
  });
  const db = getDatabase();
  assert.ok(
    db
      .prepare("SELECT user_id FROM account_deletions WHERE user_id=?")
      .get(alice.id),
    "self-service deletion records a restore tombstone",
  );
  for (const table of [
    "wardrobe_spaces",
    "photo_assets",
    "analysis_jobs",
    "usage_daily",
  ])
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
          .get(alice.id) as { count: number }
      ).count,
      0,
    );
  assert.equal((await GET(req("/api/wardrobe", alice))).status, 401);
  assert.equal((await GET(req("/api/wardrobe", bob))).status, 200);
  db.close();
});
