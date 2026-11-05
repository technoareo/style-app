import type { Page } from "@playwright/test";
import { test, expect } from "./accounts";

/** Build 020 repairs: formal compatibility, layer wording, the conflicting dimension, season warning and saved season. */
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
async function restore(page: Page, wardrobe: unknown[]) {
  await page.goto("/");
  await expect(page.getByText("Opening your wardrobe…")).not.toBeVisible();
  await page.getByLabel("Restore backup", { exact: true }).setInputFiles({
    name: "tags.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ version: 1, name: "Tags", wardrobe, looks: [] }),
    ),
  });
  await expect(
    page.getByText(/Backup items added to your account/),
  ).toBeVisible();
}

test("a formal gown tagged evening is offered for a formal event without being called unsuitable", async ({
  page,
}) => {
  await restore(page, [
    item("g", "Evening gown", "Dresses", {
      formality: "formal",
      occasions: ["evening"],
    }),
    item("h", "Formal heels", "Shoes", { formality: "formal" }),
  ]);
  await page.getByLabel("Occasion", { exact: true }).selectOption("formal");
  await expect(page.getByText("Your formal look")).toBeVisible();
  await expect(page.locator(".look-items .item-info b")).toHaveText([
    "Evening gown",
    "Formal heels",
  ]);
  await expect(
    page.getByText(/No piece is tagged for formal event itself/),
  ).toBeVisible();
  await expect(page.getByText(/not a confirmed fit/)).toHaveCount(0);
  await expect(page.getByText(/Closest formal event combination/)).toHaveCount(
    0,
  );
});

test("a mismatched cold-weather layer is explained separately and the look keeps its title", async ({
  page,
}) => {
  const tag = { occasions: ["work"], seasons: ["winter"] };
  await restore(page, [
    item("t", "Wool top", "Tops", tag),
    item("b", "Wool trousers", "Bottoms", tag),
    item("s", "Winter shoes", "Shoes", tag),
    item("c", "Beach cover-up", "Outerwear", {
      occasions: ["lounge"],
      seasons: ["summer"],
    }),
  ]);
  await page.getByLabel("Occasion", { exact: true }).selectOption("work");
  await page.getByLabel("Season", { exact: true }).selectOption("winter");
  await page.getByLabel("Temperature · °C").fill("6");
  await expect(page.getByText("Your work look")).toBeVisible();
  await expect(page.locator(".look-items .item-info b").last()).toHaveText(
    "Beach cover-up",
  );
  await expect(
    page.getByText(/Every one of the main pieces is tagged for work in winter/),
  ).toBeVisible();
  await expect(
    page.getByText(
      /The layer is added for warmth at 6°C and is not confirmed for work in winter: Beach cover-up \(occasions: lounge, not work; seasons: summer, not winter\)/,
    ),
  ).toBeVisible();
});

test("the mismatch text names the season when only the season conflicts", async ({
  page,
}) => {
  await restore(page, [
    item("t", "Linen top", "Tops", {
      occasions: ["work"],
      seasons: ["summer"],
    }),
    item("b", "Trousers", "Bottoms", {
      occasions: ["work"],
      seasons: ["winter"],
    }),
    item("s", "Shoes", "Shoes", { occasions: ["work"], seasons: ["winter"] }),
  ]);
  await page.getByLabel("Occasion", { exact: true }).selectOption("work");
  await page.getByLabel("Season", { exact: true }).selectOption("winter");
  const note = page.getByText(/not a confirmed fit for work in winter/);
  await expect(note).toContainText("Linen top (seasons: summer, not winter)");
  await expect(note).not.toContainText("occasions:");
});

test("winter with a hot day warns, and the chosen season is saved with the look", async ({
  page,
}) => {
  await restore(page, [
    item("t", "Wool top", "Tops", { seasons: ["winter"] }),
    item("b", "Trousers", "Bottoms"),
    item("s", "Shoes", "Shoes"),
  ]);
  await page.getByLabel("Season", { exact: true }).selectOption("winter");
  await page.getByLabel("Temperature · °C").fill("30");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Winter is selected but the temperature is 30°C" }),
  ).toBeVisible();
  await page.getByLabel("Temperature · °C").fill("5");
  await expect(page.getByText(/Winter is selected but/)).toHaveCount(0);
  await page.getByRole("button", { name: "Save look", exact: true }).click();
  await page.getByRole("button", { name: "Saved looks", exact: true }).click();
  await expect(page.getByText(/· everyday · winter/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Saved looks", exact: true }).click();
  await expect(page.getByText(/· everyday · winter/)).toBeVisible();
});
