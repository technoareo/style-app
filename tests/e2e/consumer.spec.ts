import { test, expect } from "./accounts";
test("consumer can create, style, save, edit and reload wardrobe", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Opening your wardrobe…")).not.toBeVisible();
  await expect(page.getByText("Let’s build your first look")).toBeVisible();
  await page
    .getByRole("button", { name: "Explore a clearly labeled sample wardrobe" })
    .click();
  await expect(
    page.getByRole("button", { name: "Save look", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save look", exact: true }).click();
  await page.getByRole("button", { name: "Saved looks", exact: true }).click();
  await expect(page.getByText("Everyday tee", { exact: true })).toBeVisible();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit Everyday tee", exact: true })
    .click();
  await page.getByLabel("Item name", { exact: true }).fill("My white tee");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText(/ALL CHANGES SAVED/)).toBeVisible();
  await page.reload();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("My white tee", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Saved looks", exact: true }).click();
  await expect(page.getByText("Everyday tee", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.screenshot({
    path: `docs/verification/${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByLabel("Occasion", { exact: true }).selectOption("formal");
  await expect(page.getByText(/No complete formal outfit yet/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("backup merges into the signed-in account and invalid backup preserves data", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore a clearly labeled sample wardrobe" })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  await page.getByLabel("Restore backup", { exact: true }).setInputFiles(path!);
  await expect(
    page.getByText("Backup items added to your account. Saving…", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("Everyday tee", { exact: true })).toHaveCount(2);
  await page.getByLabel("Restore backup", { exact: true }).setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":999}'),
  });
  await expect(
    page.getByText(
      "Could not restore this backup. Your current wardrobe is unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Everyday tee", { exact: true })).toHaveCount(2);
});
test("upload review validates detections, crop, cancel, and persistence", async ({
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
            name: "Detected shirt",
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
  await page.goto("/");
  await page
    .getByRole("button", { name: "Add my clothes", exact: true })
    .click();
  await page.getByLabel("Allow the server to analyze this photo.").check();
  await page
    .getByLabel("Choose a clothing photo", { exact: true })
    .setInputFiles("tests/fixtures/public-shirt.jpg");
  await expect(page.getByText("Review 1 detected item")).toBeVisible();
  const frame = await page.locator(".review-image").boundingBox();
  const photo = await page.locator(".review-image img").boundingBox();
  expect(photo!.height).toBeLessThanOrEqual(frame!.height + 1);
  await expect(
    page.getByRole("button", { name: "Add 1 item to my wardrobe" }),
  ).toBeDisabled();
  await page.getByText("Adjust item crop", { exact: true }).click();
  await page.getByLabel("Left", { exact: true }).fill("10");
  await expect(page.getByLabel("Details checked")).toBeDisabled();
  await page.getByRole("button", { name: "Update crop", exact: true }).click();
  await expect(page.getByLabel("Details checked")).toBeEnabled();
  await page.getByLabel("Details checked").check();
  await page
    .getByRole("button", { name: "Add 1 item to my wardrobe" })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();
  await expect(page.getByText(/ALL CHANGES SAVED/)).toBeVisible();
  await page.reload();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();
});
test("sign-out is guarded while a save is delayed and then fails", async ({
  page,
}) => {
  await page.route("**/api/wardrobe", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fulfill({
      status: 500,
      json: { error: "Simulated save failure" },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore a clearly labeled sample wardrobe" })
    .click();
  await expect(page.getByText(/CHANGES HAVE NOT BEEN SAVED/)).toBeVisible();
  await page.getByRole("button", { name: "Test wearer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Your account" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/have not finished saving yet/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Sign out", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Export draft", exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Export draft", exact: true })
    .click();
  await downloadPromise;
  await dialog
    .getByRole("button", {
      name: "Discard unsaved changes and sign out…",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("button", { name: "Discard and sign out", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
test("manual item entry stays focused and Escape closes dialog", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await page.getByRole("button", { name: "Add an item manually" }).click();
  await page
    .getByLabel("Item name", { exact: true })
    .pressSequentially("My linen shirt");
  await expect(page.getByLabel("Item name", { exact: true })).toHaveValue(
    "My linen shirt",
  );
  await page.getByLabel("Category", { exact: true }).selectOption("Tops");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("My linen shirt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit My linen shirt" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
