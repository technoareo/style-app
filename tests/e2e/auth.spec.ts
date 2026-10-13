import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { waitForMail } from "../helpers/mailCapture";
test("consumer signs up, verifies email, signs in and opens their wardrobe in another browser", async ({
  page,
  browser,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "The same account flow is covered on desktop; consumer screens run on both sizes.",
  );
  if (process.env.SMTP_URL)
    throw new Error("This test requires private development mail capture.");
  const email = `signup-${randomUUID()}@example.test`,
    password = "My style test passphrase 51!";
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Your name", { exact: true }).fill("New wearer");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByText("Check your email to verify your account, then sign in."),
  ).toBeVisible();
  // Local mail capture is eventual (durable outbox): poll for it.
  const dir = process.env.STYLE_DATA_DIR || path.join(process.cwd(), ".data");
  const message = await waitForMail(dir, email, "Verify");
  const url = message.text.split(": ").slice(1).join(": ");
  await page.goto(url);
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Let’s build your first look")).toBeVisible();
  await page.getByRole("button", { name: "My wardrobe", exact: true }).click();
  await page.getByRole("button", { name: "Add an item manually" }).click();
  await page
    .getByLabel("Item name", { exact: true })
    .fill("Cross-device white tee");
  await page.getByLabel("Category", { exact: true }).selectOption("Tops");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText(/ALL CHANGES SAVED/)).toBeVisible();
  const second = await browser.newContext();
  try {
    const other = await second.newPage();
    await other.goto("http://127.0.0.1:3000/");
    await other.getByLabel("Email", { exact: true }).fill(email);
    await other.getByLabel("Password", { exact: true }).fill(password);
    await other.getByRole("button", { name: "Sign in", exact: true }).click();
    await other
      .getByRole("button", { name: "My wardrobe", exact: true })
      .click();
    await expect(
      other.getByText("Cross-device white tee", { exact: true }),
    ).toBeVisible();
  } finally {
    await second.close();
  }
  await page.getByRole("button", { name: "New wearer", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("button", { name: "Forgot password?", exact: true })
    .click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click();
  await expect(
    page.getByText(
      "If an account matches this email, a password reset link is on its way.",
    ),
  ).toBeVisible();
  const resetMail = await waitForMail(dir, email, "Reset");
  await page.goto(resetMail.text.split(": ").slice(1).join(": "));
  const replacement = "Updated style passphrase 62!";
  await page.getByLabel("New password", { exact: true }).fill(replacement);
  await page
    .getByRole("button", { name: "Update password", exact: true })
    .click();
  await expect(
    page.getByText("Password updated. Sign in with your new password."),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Back to sign in", exact: true })
    .click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(replacement);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "New wearer", exact: true }).click();
  await page
    .getByText("Delete account and all saved photos", { exact: true })
    .click();
  await page.getByLabel("Password", { exact: true }).fill(replacement);
  await page
    .getByLabel("Type DELETE to confirm", { exact: true })
    .fill("DELETE");
  await page
    .getByRole("button", { name: "Delete my account", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
