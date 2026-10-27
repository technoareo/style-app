import sharp from "sharp";
import { test, expect } from "./accounts";

/**
 * Build 018 review of ONE item with suggested attributes, against a controlled
 * analysis answer (no model). The photo is a generated plain image, so no
 * third-party or copyrighted photograph is needed. It shows the interface:
 * subjective suggestions (seasons, occasions) are offered but never applied
 * until the user chooses, uncertainty is stated readably, the model's score is
 * not shown as reassurance, singular/plural wording is right, and the user's
 * choices (not the AI's) are what persist.
 */

let jpeg: Buffer;
let image: string;
test.beforeAll(async () => {
  jpeg = await sharp({
    create: { width: 480, height: 480, channels: 3, background: "#4a6fa5" },
  })
    .jpeg()
    .toBuffer();
  image = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
});

const suggestion = {
  name: "Detected shirt",
  category: "Tops",
  color: "Blue",
  pattern: "Solid",
  material: "denim",
  fit: "relaxed",
  seasons: ["spring", "autumn"],
  occasions: ["everyday", "work"],
  uncertain: ["color", "material"],
  formality: "casual",
  brand: "",
  size: "",
  confidence: 0.25,
  evidence: "Short sleeves visible",
  box: [0, 0, 1, 1],
};

async function openReview(
  page: import("@playwright/test").Page,
  items: unknown[],
  heading: string,
) {
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    return route.fulfill({ json: { image, warning: "", items } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Add my clothes", exact: true }).click();
  await page.getByLabel("Allow the server to analyze this photo.").check();
  await page
    .getByLabel("Choose a clothing photo", { exact: true })
    .setInputFiles({ name: "item.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await expect(page.getByText(heading, { exact: true })).toBeVisible();
}

test("subjective suggestions are offered, not applied; uncertainty is readable; the user's choices persist", async ({
  page,
}) => {
  await openReview(page, [suggestion], "Review 1 detected item");

  // Visible, checkable details are pre-filled; subjective ones are NOT.
  await expect(page.getByLabel("Material (only if clearly visible)")).toHaveValue("denim");
  await expect(page.getByLabel("Fit", { exact: true })).toHaveValue("relaxed");
  for (const name of ["Spring", "Summer", "Autumn", "Winter", "Everyday", "Work", "Evening"])
    await expect(page.getByRole("checkbox", { name })).not.toBeChecked();
  await expect(page.getByText("AI suggests: Spring, Autumn.")).toBeVisible();
  await expect(page.getByText("AI suggests: Everyday, Work.")).toBeVisible();

  // Readable uncertainty and a low-confidence note in the AI's own words.
  await expect(page.getByText(/The AI was unsure about: color and material\./)).toBeVisible();
  await expect(page.getByText(/The AI called this a poor guess \(its scores are unverified\)/)).toBeVisible();
  await expect(page.getByText(/Low confidence/)).toHaveCount(0);

  // Singular wording, and nothing can be saved before the details are checked.
  const add = page.getByRole("button", { name: "Add 1 item to my wardrobe" });
  await expect(add).toBeDisabled();

  // The user applies the season suggestion in one press, ignores the occasion
  // one and ticks their own choice instead.
  await page.getByRole("button", { name: "Use these seasons" }).click();
  await expect(page.getByRole("checkbox", { name: "Spring" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Autumn" })).toBeChecked();
  await expect(page.getByText("AI suggests: Spring, Autumn.")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Evening" }).check();
  await page.getByLabel("Material (only if clearly visible)").fill("");
  await page.getByLabel("Details checked").check();
  await add.click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();

  const verify = async () => {
    await page.getByRole("button", { name: "Edit Detected shirt" }).click();
    await expect(page.getByLabel("Material (only if clearly visible)")).toHaveValue("");
    await expect(page.getByLabel("Fit", { exact: true })).toHaveValue("relaxed");
    await expect(page.getByRole("checkbox", { name: "Spring" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Autumn" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Summer" })).not.toBeChecked();
    // Only what the user chose: the unapplied occasion guess ("Everyday", "Work") was not saved.
    await expect(page.getByRole("checkbox", { name: "Evening" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Everyday" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Work" })).not.toBeChecked();
    await expect(page.getByText(/The AI was unsure/)).toHaveCount(0);
    await expect(page.getByText(/AI suggests/)).toHaveCount(0);
  };
  await verify();
  await page.keyboard.press("Escape");
  await page.reload();
  await verify();
});

test("a high model score is not shown as reassurance, and a single doubt reads naturally", async ({
  page,
}) => {
  await openReview(
    page,
    [{ ...suggestion, confidence: 0.75, uncertain: ["fit"] }],
    "Review 1 detected item",
  );
  await expect(page.getByText(/Good confidence/)).toHaveCount(0);
  await expect(page.getByText(/poor guess|reported doubts|Good confidence|high confidence/i)).toHaveCount(0);
  await expect(page.getByText(/The AI was unsure about: fit\. Please check it\./)).toBeVisible();
});

test("an answer without the new attributes (an older result) still reviews and saves", async ({
  page,
}) => {
  const { material, fit, seasons, occasions, uncertain, ...plain } = suggestion;
  void material; void fit; void seasons; void occasions; void uncertain;
  await openReview(page, [{ ...plain, confidence: 0.75 }], "Review 1 detected item");
  await expect(page.getByLabel("Material (only if clearly visible)")).toHaveValue("");
  await expect(page.getByLabel("Fit", { exact: true })).toHaveValue("unknown");
  await expect(page.getByText(/The AI was unsure/)).toHaveCount(0);
  await expect(page.getByText(/AI suggests/)).toHaveCount(0);
  await page.getByLabel("Details checked").check();
  await page.getByRole("button", { name: "Add 1 item to my wardrobe" }).click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();
});

test("a score is only ever shown as a doubt in the AI's own words, never as reassurance", async ({ page }) => {
  await openReview(page, [{ ...suggestion, confidence: 0.5, uncertain: ["color", "pattern", "material", "fit"] }], "Review 1 detected item");
  await expect(page.getByText(/The AI reported doubts about this item \(its scores are unverified\)/)).toBeVisible();
  await expect(page.getByText(/The AI was unsure about: color, pattern, material and fit\./)).toBeVisible();
  await expect(page.getByText(/Good confidence|high confidence|moderately sure/i)).toHaveCount(0);
});

test("shoes always carry a crop check, whatever the model said, including after the user changes the category", async ({ page }) => {
  await openReview(page, [{ ...suggestion, name: "Perforated leather shoe", category: "Shoes", uncertain: [] }], "Review 1 detected item");
  const note = page.getByText(/Shoes: please check the crop/);
  await expect(note).toBeVisible();
  await expect(page.getByText(/The AI may have outlined only one/)).toBeVisible();
  await page.getByLabel("Category").selectOption("Tops");
  await expect(note).toHaveCount(0);
  await page.getByLabel("Category").selectOption("Shoes");
  await expect(note).toBeVisible();
});

test("an unnamed or unsorted suggestion cannot be saved until the user names and sorts it; nothing is invented", async ({ page }) => {
  await openReview(page, [{ ...suggestion, name: "", category: "Unsorted", uncertain: ["category"], confidence: 0.25 }], "Review 1 detected item");
  const name = page.getByPlaceholder("Name this item");
  await expect(name).toHaveValue("");
  await expect(page.getByText(/The AI was unsure about: category./)).toBeVisible();
  await page.getByLabel("Details checked").check();
  const add = page.getByRole("button", { name: "Add 1 item to my wardrobe" });
  await expect(add).toBeDisabled();
  await name.fill("My shirt");
  await expect(add).toBeDisabled(); // still Unsorted
  await page.getByLabel("Category").selectOption("Tops");
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByText("My shirt", { exact: true })).toBeVisible();
});

test("several items keep the plural wording", async ({ page }) => {
  await openReview(
    page,
    [suggestion, { ...suggestion, name: "Second shirt" }],
    "Review 2 detected items",
  );
  await expect(page.getByRole("button", { name: "Add 2 items to my wardrobe" })).toBeVisible();
});
