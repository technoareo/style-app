import { test, expect } from "./accounts";

/**
 * Build 013 (G21). The server now allows one in-flight photo upload per
 * account and refuses a second with a retryable 429 (`upload-in-progress`).
 * The client saves a reviewed photo's items one upload at a time and repeats an
 * upload that was refused that way. This checks, in a real browser against the
 * built app, that several reviewed items from one photo still save together
 * and survive a reload, including when one upload is refused once.
 *
 * /api/analyze is answered by the test (as the other upload specs do), so no
 * AI model is involved. Not run by the author; root runs it.
 */
test("several reviewed items from one photo save together, and a refused upload is repeated without losing the draft", async ({
  page,
}) => {
  const names = ["Blue shirt", "Grey trousers", "White sneakers"];
  const categories = ["Tops", "Bottoms", "Shoes"];
  const boxes = [
    [0, 0, 0.34, 1],
    [0.33, 0, 0.34, 1],
    [0.66, 0, 0.34, 1],
  ];
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    const { image } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        image,
        warning: "Approximate crop",
        items: names.map((name, i) => ({
          name,
          category: categories[i],
          color: "Blue",
          pattern: "Solid",
          formality: "casual",
          brand: "",
          size: "",
          confidence: 0.6,
          evidence: "Visible in the photo",
          box: boxes[i],
        })),
      },
    });
  });
  // The second upload attempt is refused once, exactly as the server does when
  // another upload from the same account is still being read.
  let uploads = 0;
  let refused = 0;
  await page.route("**/api/photos", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    uploads++;
    if (uploads === 2) {
      refused++;
      return route.fulfill({
        status: 429,
        headers: { "retry-after": "1" },
        json: {
          error:
            "Another photo from your account is still being processed. Try again in a moment.",
          code: "upload-in-progress",
          retryAfterSeconds: 1,
        },
      });
    }
    return route.continue();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add my clothes", exact: true }).click();
  await page.getByLabel("Allow the server to analyze this photo.").check();
  await page
    .getByLabel("Choose a clothing photo", { exact: true })
    .setInputFiles("tests/fixtures/public-shirt.jpg");
  await expect(page.getByText("Review 3 detected items")).toBeVisible();
  const checks = page.getByLabel("Details checked");
  await expect(checks).toHaveCount(3);
  for (let i = 0; i < 3; i++) await checks.nth(i).check();
  await page.getByRole("button", { name: "Add 3 items to my wardrobe" }).click();

  // The dialog closes itself once the server acknowledged the save. Wait for
  // that, then open My wardrobe explicitly: the plain item name also appears on
  // the Today view's edit button, so it is checked on the wardrobe item cards.
  await expect(page.getByText("Review 3 detected items")).toBeHidden({
    timeout: 20_000,
  });
  const sidebar = page.getByRole("complementary");
  const wardrobeCard = (name: string) =>
    page.getByRole("article").filter({
      has: page.getByText(name, { exact: true }),
    });
  await sidebar.getByRole("button", { name: "My wardrobe", exact: true }).click();
  for (const name of names)
    await expect(wardrobeCard(name)).toHaveCount(1, { timeout: 20_000 });
  for (const name of names)
    await expect(wardrobeCard(name)).toBeVisible();
  await expect(page.getByText(/ALL CHANGES SAVED/)).toBeVisible();
  expect(refused, "the refusal was actually served once").toBe(1);
  expect(uploads, "the refused upload was repeated").toBeGreaterThanOrEqual(2);

  await page.reload();
  await sidebar.getByRole("button", { name: "My wardrobe", exact: true }).click();
  for (const name of names) {
    await expect(wardrobeCard(name)).toHaveCount(1);
    await expect(wardrobeCard(name)).toBeVisible();
  }
});

/**
 * A 408 from the wardrobe save (the server's 20 s body deadline; the 3 MB
 * ceiling needs about 1.2 Mbit/s to finish in time) must not lose the review:
 * the drafts stay, the server's message is shown, and pressing the button
 * again saves them. The 408 is served by the test.
 */
test("a 408 on the wardrobe save keeps the reviewed draft and a second press saves it", async ({
  page,
}) => {
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    const { image } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        image,
        warning: "Approximate crop",
        items: [
          {
            name: "Slow-upload shirt",
            category: "Tops",
            color: "Blue",
            pattern: "Solid",
            formality: "casual",
            brand: "",
            size: "",
            confidence: 0.6,
            evidence: "Short sleeves visible",
            box: [0, 0, 1, 1],
          },
        ],
      },
    });
  });
  let puts = 0;
  await page.route("**/api/wardrobe", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    if (puts === 1)
      return route.fulfill({
        status: 408,
        json: { error: "The upload took too long. Please try again." },
      });
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add my clothes", exact: true }).click();
  await page.getByLabel("Allow the server to analyze this photo.").check();
  await page
    .getByLabel("Choose a clothing photo", { exact: true })
    .setInputFiles("tests/fixtures/public-shirt.jpg");
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await page.getByLabel("Details checked").check();
  await page.getByRole("button", { name: "Add 1 items to my wardrobe" }).click();
  await expect(
    page.getByText(/Your items were not saved: The upload took too long/),
  ).toBeVisible({ timeout: 20_000 });
  // The draft is still on screen and can be saved again.
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await page.getByRole("button", { name: "Add 1 items to my wardrobe" }).click();
  await expect(page.getByText("Slow-upload shirt", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/ALL CHANGES SAVED/)).toBeVisible();
  expect(puts).toBeGreaterThanOrEqual(2);
});
