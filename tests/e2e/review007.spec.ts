import { readFileSync } from "node:fs";
import { test, expect } from "./accounts";

/**
 * Build 007 consumer flows with a controlled analysis service: dress code is
 * never taken from an unseen AI guess, a shoe pair is merged only on
 * confirmation, and a queued photo survives closing the dialog and a reload.
 */

const image = `data:image/jpeg;base64,${readFileSync("tests/fixtures/public-shirt.jpg").toString("base64")}`;
const item = (over: Record<string, unknown>) => ({
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
  ...over,
});

async function openUpload(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Add my clothes", exact: true })
    .click();
  await page.getByLabel("Allow the server to analyze this photo.").check();
}
/** A promise the test releases at a chosen moment (replaces fixed sleeps). */
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
/** Two animation frames: whatever the page was going to do with a delivered answer has been done. */
const settle = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
const choose = (page: import("@playwright/test").Page) =>
  page
    .getByLabel("Choose a clothing photo", { exact: true })
    .setInputFiles("tests/fixtures/public-shirt.jpg");

test("an AI formal guess is only a suggestion until the user chooses it", async ({
  page,
}) => {
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    return route.fulfill({
      json: {
        image,
        warning: "",
        items: [item({ formality: "formal" })],
      },
    });
  });
  await openUpload(page);
  await choose(page);
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  const dressCode = page.getByLabel("Dress code", { exact: true });
  await expect(dressCode).toHaveValue("unknown");
  await expect(page.getByText(/AI guessed “formal”/)).toBeVisible();
  await expect(page.getByLabel("Warmth (optional)")).toHaveValue("unknown");
  // Saving without touching it keeps the item "not sure".
  await page.getByLabel("Details checked").check();
  await page
    .getByRole("button", { name: "Add 1 items to my wardrobe" })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Detected shirt" }).click();
  await expect(page.getByLabel("Dress code", { exact: true })).toHaveValue(
    "unknown",
  );
});

test("a shoe pair is merged only after confirmation, and distinct items stay separate", async ({
  page,
}) => {
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    return route.fulfill({
      json: {
        image,
        warning: "",
        items: [
          item({
            name: "shoe",
            category: "Shoes",
            color: "beige",
            box: [0.558, 0.214, 0.384, 0.404],
          }),
          item({
            name: "shoe",
            category: "Shoes",
            color: "beige",
            box: [0.382, 0.3, 0.183, 0.625],
          }),
          item({
            name: "White shirt",
            category: "Tops",
            color: "white",
            box: [0.0, 0.0, 0.3, 0.3],
          }),
        ],
      },
    });
  });
  await openUpload(page);
  await choose(page);
  await expect(page.getByText("Review 3 detected items")).toBeVisible();
  const suggestion = page.getByRole("group", { name: "Possible pair of shoes" });
  await expect(suggestion).toBeVisible();
  // Nothing was merged on its own.
  await expect(page.locator(".review-card")).toHaveCount(3);
  await suggestion.getByRole("button", { name: "Merge as one pair" }).click();
  await expect(page.getByText("Review 2 detected items")).toBeVisible();
  await expect(page.getByLabel("Name Pair of shoes")).toBeVisible();
  await expect(page.getByLabel("Name White shirt")).toBeVisible();
  // Merging reset review: both items must be checked again.
  await expect(
    page.getByRole("button", { name: "Add 2 items to my wardrobe" }),
  ).toBeDisabled();
  for (const box of await page.getByLabel("Details checked").all())
    await box.check();
  await page
    .getByRole("button", { name: "Add 2 items to my wardrobe" })
    .click();
  await expect(page.getByText("Pair of shoes", { exact: true })).toBeVisible();
});

/** A completed job served by a controlled queue; DELETE behaviour is switchable. */
async function mockCompletedJob(
  page: import("@playwright/test").Page,
  state: { discarded: boolean; failDelete: boolean; posted?: boolean },
) {
  const now = Date.now();
  const summary = () => ({
    id: "job-save",
    status: "completed",
    createdAt: now,
    expiresAt: now + 3_600_000,
    serverNow: Date.now(),
  });
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    // The job exists only once this upload has been accepted, and it then
    // survives reloads (as a real queued job does) until it is discarded.
    state.posted = true;
    return route.fulfill({ status: 202, json: summary() });
  });
  await page.route("**/api/analysis-jobs", (route) =>
    route.fulfill({
      json: { jobs: state.posted && !state.discarded ? [summary()] : [] },
    }),
  );
  await page.route("**/api/analysis-jobs/job-save", (route) => {
    if (route.request().method() === "DELETE") {
      if (state.failDelete)
        return route.fulfill({ status: 500, json: { error: "Simulated discard failure" } });
      state.discarded = true;
      return route.fulfill({ json: { id: "job-save", status: "cancelled" } });
    }
    return route.fulfill({
      json: { ...summary(), result: { image, warning: "", items: [item({})] } },
    });
  });
}

test("a failed wardrobe save keeps the photo result; after reload and retry there is one durable garment and the result is discarded only after the acknowledged save", async ({
  page,
}) => {
  const state = { discarded: false, failDelete: false };
  await mockCompletedJob(page, state);
  let failPut = true;
  let puts = 0;
  await page.route("**/api/wardrobe", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    if (failPut)
      return route.fulfill({ status: 503, json: { error: "Simulated outage" } });
    return route.continue();
  });
  await openUpload(page);
  await choose(page);
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await page.getByLabel("Details checked").check();
  await page
    .getByRole("button", { name: "Add 1 items to my wardrobe" })
    .click();
  // The save failed: the dialog, results and job are all still there.
  await expect(page.getByText(/Your items were not saved/)).toBeVisible();
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  expect(state.discarded).toBe(false);

  // Reload: the unsaved wardrobe change is gone, the result is not.
  await page.reload();
  await page.getByRole("button", { name: "Review photo results" }).click();
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await expect(page.getByLabel("Details checked")).toBeChecked();
  expect(state.discarded).toBe(false);

  // Retry succeeds once; only then is the result discarded.
  failPut = false;
  await page
    .getByRole("button", { name: "Add 1 items to my wardrobe" })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();
  await expect.poll(() => state.discarded).toBe(true);
  expect(puts).toBeGreaterThan(1);
  await page.reload();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toHaveCount(1);
});

test("a retry after a failed save in the same dialog adds the garment once", async ({
  page,
}) => {
  const state = { discarded: false, failDelete: false };
  await mockCompletedJob(page, state);
  let failPut = true;
  await page.route("**/api/wardrobe", (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (failPut)
      return route.fulfill({ status: 503, json: { error: "Simulated outage" } });
    return route.continue();
  });
  await openUpload(page);
  await choose(page);
  await page.getByLabel("Details checked").check();
  const add = page.getByRole("button", { name: "Add 1 items to my wardrobe" });
  await add.click();
  await expect(page.getByText(/Your items were not saved/)).toBeVisible();
  expect(state.discarded).toBe(false);
  // Correct the item after the failed attempt: the retry must save these
  // latest values, not the first attempt's.
  await page.getByLabel("Name Detected shirt").fill("Corrected shirt");
  await page.getByLabel("Color", { exact: true }).fill("Green");
  failPut = false;
  await add.click();
  await expect(page.getByText("Corrected shirt", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Detected shirt", { exact: true })).toHaveCount(0);
  await expect.poll(() => state.discarded).toBe(true);
  await page.reload();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("Corrected shirt", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Detected shirt", { exact: true })).toHaveCount(0);
});

test("a lost success response does not duplicate the garment when the same result is saved again", async ({
  page,
}) => {
  const state = { discarded: false, failDelete: false };
  await mockCompletedJob(page, state);
  let dropResponse = true;
  await page.route("**/api/wardrobe", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (dropResponse) {
      dropResponse = false;
      // The server commits the save, but the browser never hears about it.
      await route.fetch();
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await openUpload(page);
  await choose(page);
  await page.getByLabel("Details checked").check();
  const add = page.getByRole("button", { name: "Add 1 items to my wardrobe" });
  await add.click();
  await expect(page.getByText(/Your items were not saved/)).toBeVisible();
  expect(state.discarded).toBe(false);
  await add.click();
  await expect(page.getByText("Detected shirt", { exact: true })).toHaveCount(1);
  await expect.poll(() => state.discarded).toBe(true);
  await page.reload();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toHaveCount(1);
});

test("a failed discard after a successful save is reported honestly and not offered again", async ({
  page,
}) => {
  const state = { discarded: false, failDelete: true };
  await mockCompletedJob(page, state);
  await openUpload(page);
  await choose(page);
  await page.getByLabel("Details checked").check();
  await page
    .getByRole("button", { name: "Add 1 items to my wardrobe" })
    .click();
  await expect(
    page.getByText(/Saved to your wardrobe\. The temporary photo result could not be removed/),
  ).toBeVisible();
  expect(state.discarded).toBe(false);
  // Focus is no longer on a control in the dialog (the draft controls were
  // removed); Escape must still close it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review photo results" }),
  ).toHaveCount(0);
  // Once the server accepts the discard again, the next open retries it.
  state.failDelete = false;
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "My wardrobe", exact: true })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toHaveCount(1);
});

test("a superseded or cancelled result that arrives late cannot overwrite the newer reviewed photo", async ({
  page,
}) => {
  const now = Date.now();
  const state = { oldDiscarded: false, newPosted: false, oldHandled: false };
  // The old photo's poll answer is held until the test lets it go, instead of
  // a fixed sleep that can run before or after the other steps.
  const oldPoll = latch();
  const base = (id: string, status: string) => ({
    id,
    status,
    createdAt: now,
    expiresAt: now + 3_600_000,
    serverNow: Date.now(),
    position: 1,
    estimatedReadyMs: 60_000,
  });
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    state.newPosted = true;
    return route.fulfill({ status: 202, json: base("job-new", "completed") });
  });
  // An earlier photo is still in flight when the dialog opens (resume).
  await page.route("**/api/analysis-jobs", (route) =>
    route.fulfill({
      json: {
        jobs: [
          ...(state.oldDiscarded ? [] : [base("job-old", "queued")]),
          ...(state.newPosted ? [base("job-new", "completed")] : []),
        ],
      },
    }),
  );
  // When its held answer is finally released it is a finished result with
  // different content (the page has aborted that request by then).
  await page.route("**/api/analysis-jobs/job-old", async (route) => {
    if (route.request().method() === "DELETE") {
      state.oldDiscarded = true;
      return route.fulfill({ json: { id: "job-old", status: "cancelled" } });
    }
    await oldPoll.promise;
    await route
      .fulfill({
        json: {
          ...base("job-old", "completed"),
          result: { image, warning: "", items: [item({ name: "Old shirt" })] },
        },
      })
      .catch(() => {});
    state.oldHandled = true;
  });
  await page.route("**/api/analysis-jobs/job-new", (route) =>
    route.fulfill({
      json: {
        ...base("job-new", "completed"),
        result: { image, warning: "", items: [item({ name: "New shirt" })] },
      },
    }),
  );
  await openUpload(page);
  // The resumed old photo is in flight: cancel it deliberately. Wait for the
  // cancellation to COMPLETE in the page and for the picker to be usable, as a
  // person would, before uploading a new photo and starting to review it.
  await page.getByRole("button", { name: "Cancel analysis" }).click();
  await expect.poll(() => state.oldDiscarded).toBe(true);
  await expect(page.getByText("Analysis cancelled.")).toBeVisible();
  await expect(
    page.getByLabel("Choose a clothing photo", { exact: true }),
  ).toBeEnabled();
  await choose(page);
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await page.getByLabel("Name New shirt").fill("My edited new shirt");
  await page.getByLabel("Details checked").check();
  // Now let the old, held answer go, and wait until its handler has finished
  // and the page has had two frames to react to anything it delivered.
  oldPoll.release();
  await expect.poll(() => state.oldHandled).toBe(true);
  await settle(page);
  await expect(page.getByLabel("Name My edited new shirt")).toBeVisible();
  await expect(page.getByLabel("Details checked")).toBeChecked();
  await expect(page.getByText("Old shirt")).toHaveCount(0);
  await expect(page.locator(".review-card")).toHaveCount(1);
});

test("a cancel that is still pending when a newer photo starts cannot abort or reset the newer flow, and a second press is ignored", async ({
  page,
}) => {
  const now = Date.now();
  const state = { deletes: 0, deleted: false, newPosted: false, oldHandled: false };
  const deleteGate = latch();
  const oldPoll = latch();
  const base = (id: string, status: string) => ({
    id,
    status,
    createdAt: now,
    expiresAt: now + 3_600_000,
    serverNow: Date.now(),
    position: 1,
    estimatedReadyMs: 60_000,
  });
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    state.newPosted = true;
    return route.fulfill({ status: 202, json: base("job-new", "completed") });
  });
  await page.route("**/api/analysis-jobs", (route) =>
    route.fulfill({
      json: {
        jobs: [
          ...(state.deleted ? [] : [base("job-old", "queued")]),
          ...(state.newPosted ? [base("job-new", "completed")] : []),
        ],
      },
    }),
  );
  await page.route("**/api/analysis-jobs/job-old", async (route) => {
    if (route.request().method() === "DELETE") {
      state.deletes++;
      // The server's answer to the cancel is held: the cancel stays pending.
      await deleteGate.promise;
      state.deleted = true;
      return route.fulfill({ json: { id: "job-old", status: "cancelled" } });
    }
    await oldPoll.promise;
    await route.fulfill({ status: 404, json: { error: "gone" } }).catch(() => {});
    state.oldHandled = true;
  });
  await page.route("**/api/analysis-jobs/job-new", (route) =>
    route.fulfill({
      json: {
        ...base("job-new", "completed"),
        result: { image, warning: "", items: [item({ name: "New shirt" })] },
      },
    }),
  );
  await openUpload(page);
  const cancel = page.getByRole("button", { name: "Cancel analysis" });
  await cancel.click();
  await expect.poll(() => state.deletes).toBe(1);
  // A second press while the first request is pending: the button is disabled
  // and no second request is sent.
  await expect(cancel).toBeDisabled();
  await cancel.click({ force: true });
  await settle(page);
  expect(state.deletes).toBe(1);

  // A newer upload starts while the cancel is still pending (setInputFiles
  // ignores the disabled picker, which a person could not do).
  await choose(page);
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await page.getByLabel("Name New shirt").fill("Edited while cancel pending");

  // The cancel now completes. It belongs to a flow that no longer owns the
  // dialog: it must not abort the newer flow, announce a cancellation, or
  // clear what the person is reviewing.
  deleteGate.release();
  await expect.poll(() => state.deleted).toBe(true);
  await settle(page);
  oldPoll.release();
  await expect.poll(() => state.oldHandled).toBe(true);
  await settle(page);
  expect(state.deletes).toBe(1);
  await expect(page.getByText("Analysis cancelled.")).toHaveCount(0);
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  await expect(page.getByLabel("Name Edited while cancel pending")).toBeVisible();
  await expect(page.locator(".review-card")).toHaveCount(1);
  await expect(page.getByText("Old shirt")).toHaveCount(0);
});

test("a queued photo keeps processing in the background and resumes after a reload", async ({
  page,
}) => {
  const now = Date.now();
  const state = { ready: false, discarded: false, posted: false };
  const summary = () => ({
    id: "job-resume",
    status: state.ready ? "completed" : "queued",
    createdAt: now,
    expiresAt: now + 3_600_000,
    serverNow: Date.now(),
    position: 1,
    estimatedStartMs: 0,
    estimatedReadyMs: 60_000,
  });
  await page.route("**/api/analyze", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { configured: true } });
    state.posted = true;
    return route.fulfill({ status: 202, json: summary() });
  });
  await page.route("**/api/analysis-jobs", (route) =>
    route.fulfill({
      json: { jobs: state.posted && !state.discarded ? [summary()] : [] },
    }),
  );
  await page.route("**/api/analysis-jobs/job-resume", (route) => {
    if (route.request().method() === "DELETE") {
      state.discarded = true;
      return route.fulfill({ json: { id: "job-resume", status: "cancelled" } });
    }
    return route.fulfill({
      json: {
        ...summary(),
        ...(state.ready
          ? { result: { image, warning: "", items: [item({})] } }
          : {}),
      },
    });
  });
  await openUpload(page);
  await choose(page);
  await expect(page.getByText(/number 1 in line/)).toBeVisible();
  // Leaving is not cancelling.
  await page
    .getByRole("button", { name: "Continue in background" })
    .click();
  expect(state.discarded).toBe(false);
  await expect(page.getByText(/Photo analysis in progress/)).toBeVisible();

  // Another account's stale review data in this tab is never used.
  await page.evaluate(() =>
    sessionStorage.setItem(
      "style-review:someone-else:job-resume",
      JSON.stringify({ v: 1, accountId: "someone-else", jobId: "job-resume", drafts: [] }),
    ),
  );
  state.ready = true;
  await page.reload();
  await page
    .getByRole("button", { name: "Review photo results" })
    .click();
  await expect(page.getByText("Review 1 detected items")).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("style-review:someone-else:job-resume"),
    ),
  ).toBeNull();
  expect(state.discarded).toBe(false);

  // Saving the reviewed items discards the server copy (explicit save).
  await page.getByLabel("Details checked").check();
  await page
    .getByRole("button", { name: "Add 1 items to my wardrobe" })
    .click();
  await expect(page.getByText("Detected shirt", { exact: true })).toBeVisible();
  await expect.poll(() => state.discarded).toBe(true);
});
