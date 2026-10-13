import sharp from "sharp";
import { test, expect } from "./accounts";
test("analysis rejects foreign origins, missing consent and unreadable images", async ({
  page,
  accountId,
}) => {
  const request = page.context().request;
  const account = JSON.parse(accountId).id;
  const oversized = await request.post("/api/auth/sign-in/email", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: { email: "test@example.test", password: "x".repeat(40_000) },
  });
  expect(oversized.status()).toBe(413);
  const foreign = await request.post("/api/analyze", {
    headers: { origin: "https://example.com" },
    data: { consent: true, image: "data:image/png;base64,AAAA" },
  });
  expect(foreign.status()).toBe(403);
  const missing = await request.post("/api/analyze", {
    headers: { origin: "http://127.0.0.1:3000", "X-Style-Account": account },
    data: { image: "data:image/png;base64,AAAA" },
  });
  expect(missing.status()).toBe(400);
  const unreadable = await request.post("/api/analyze", {
    headers: { origin: "http://127.0.0.1:3000", "X-Style-Account": account },
    data: { consent: true, image: "data:image/png;base64,AAAA" },
  });
  expect(unreadable.status()).toBe(400);
  expect((await unreadable.json()).error).toContain("could not be read");
});
test("giant rasters are refused from their header, and cancel survives an exhausted change quota", async ({
  page,
  accountId,
}) => {
  const request = page.context().request;
  const account = JSON.parse(accountId).id;
  const headers = { origin: "http://127.0.0.1:3000", "X-Style-Account": account };
  // 9 megapixels in a few KB: refused on metadata, not decoded.
  const bomb = await sharp({
    create: { width: 3000, height: 3000, channels: 3, background: "#fff" },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const refused = await request.post("/api/analyze", {
    headers,
    data: {
      consent: true,
      image: `data:image/png;base64,${bomb.toString("base64")}`,
    },
  });
  expect(refused.status()).toBe(413);
  expect((await refused.json()).error).toContain("dimensions");

  // Use up the ordinary change quota (invalid uploads still count).
  let limited = false;
  for (let i = 0; i < 260 && !limited; i++) {
    const r = await request.post("/api/photos", {
      headers,
      data: { image: "nope" },
    });
    limited = r.status() === 429;
  }
  expect(limited).toBe(true);
  const stillLimited = await request.post("/api/photos", {
    headers,
    data: { image: "nope" },
  });
  expect(stillLimited.status()).toBe(429);

  // Cancel/discard is not blocked by that quota, but keeps every other check.
  const unknown = `/api/analysis-jobs/${crypto.randomUUID()}`;
  expect((await request.delete(unknown, { headers })).status()).toBe(404);
  expect(
    (
      await request.delete(unknown, {
        headers: { ...headers, "X-Style-Account": "someone-else" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.delete(unknown, {
        headers: { ...headers, origin: "https://example.com" },
      })
    ).status(),
  ).toBe(403);

  // Discovery is owner-only and empty for a new account.
  const list = await request.get("/api/analysis-jobs");
  expect(list.status()).toBe(200);
  expect((await list.json()).jobs).toEqual([]);
});
