import { test, expect } from "./accounts";

/**
 * Build 020: the Today view uses confirmed seasons and occasions. Items are
 * restored from a backup file so the tags are exactly what a reviewed upload
 * would have saved; no model or photo is involved.
 */
const item = (
  id: string,
  name: string,
  category: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  category,
  color: "White",
  brand: "",
  size: "",
  image: "👕",
  warmth: "medium",
  ...extra,
});
const backup = (wardrobe: unknown[]) => ({
  buffer: Buffer.from(
    JSON.stringify({ version: 1, name: "Tags", wardrobe, looks: [] }),
  ),
  name: "tags.json",
  mimeType: "application/json",
});
const tagged = [
  item("t-summer", "Linen summer tee", "Tops", {
    seasons: ["summer"],
    occasions: ["everyday"],
    formality: "casual",
  }),
  item("t-winter", "Wool winter jumper", "Tops", {
    seasons: ["winter"],
    occasions: ["everyday"],
    formality: "casual",
  }),
  item("t-work", "Work blouse", "Tops", {
    seasons: ["spring", "summer", "autumn", "winter"],
    occasions: ["work"],
    formality: "smart",
  }),
  item("b", "Plain trousers", "Bottoms", { formality: "smart" }),
  item("s", "Plain shoes", "Shoes", { formality: "smart" }),
];

async function restore(
  page: import("@playwright/test").Page,
  wardrobe: unknown[],
) {
  await page.goto("/");
  await expect(page.getByText("Opening your wardrobe…")).not.toBeVisible();
  await page
    .getByLabel("Restore backup", { exact: true })
    .setInputFiles(backup(wardrobe));
  await expect(
    page.getByText(/Backup items added to your account/),
  ).toBeVisible();
}
const lookItems = (page: import("@playwright/test").Page) =>
  page.locator(".look-items .item-info b");

test("season and occasion choices change the suggested look", async ({
  page,
}) => {
  await restore(page, tagged);
  const season = page.getByLabel("Season", { exact: true });
  const occasion = page.getByLabel("Occasion", { exact: true });
  await page.getByLabel("Temperature · °C").fill("24");

  await occasion.selectOption("everyday");
  await season.selectOption("summer");
  await expect(lookItems(page).first()).toHaveText("Linen summer tee");
  await expect(
    page.getByText(
      /1 of 3 pieces tagged for everyday, 1 of 3 pieces tagged for summer; the others have no matching tag/,
    ),
  ).toBeVisible();

  await season.selectOption("winter");
  await expect(lookItems(page).first()).toHaveText("Wool winter jumper");

  await season.selectOption("any");
  await occasion.selectOption("work");
  await expect(lookItems(page).first()).toHaveText("Work blouse");
  await expect(page.getByText("Your work look")).toBeVisible();
});

test("only mismatching pieces gives a closest-match look without claiming a fit", async ({
  page,
}) => {
  await restore(page, [
    item("t", "Beach tee", "Tops", {
      seasons: ["summer"],
      occasions: ["lounge"],
    }),
    item("b", "Beach shorts", "Bottoms", {
      seasons: ["summer"],
      occasions: ["lounge"],
    }),
    item("s", "Beach sandals", "Shoes", {
      seasons: ["summer"],
      occasions: ["lounge"],
    }),
  ]);
  await page.getByLabel("Occasion", { exact: true }).selectOption("work");
  await page.getByLabel("Season", { exact: true }).selectOption("winter");
  await expect(page.getByText("Closest work combination")).toBeVisible();
  await expect(
    page.getByText(/It is not confirmed for this plan/),
  ).toBeVisible();
  await expect(page.getByText(/not a confirmed fit/)).toBeVisible();
  await expect(page.getByText("Your work look")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save look", exact: true }),
  ).toBeVisible();
});

test("older untagged wardrobe still works and says suitability is unconfirmed", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Opening your wardrobe…")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Explore a clearly labeled sample wardrobe" })
    .click();
  await expect(page.getByText("Your daily edit")).toBeVisible();
  const before = await lookItems(page).allTextContents();
  await page.getByLabel("Season", { exact: true }).selectOption("winter");
  await expect(
    page.getByText(/No piece is tagged for everyday in winter yet/),
  ).toBeVisible();
  expect(await lookItems(page).allTextContents()).toEqual(before);
  await page.getByLabel("Occasion", { exact: true }).selectOption("formal");
  await expect(page.getByText(/No complete formal outfit yet/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
