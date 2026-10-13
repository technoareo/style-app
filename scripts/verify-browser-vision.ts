import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { verificationAccount } from "./verification-account";
async function main() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const account = await verificationAccount();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.context().addCookies(account.cookies);
    await page.goto("http://127.0.0.1:3000");
    await page
      .getByRole("button", { name: "Add my clothes", exact: true })
      .click();
    await page.getByLabel("Allow the server to analyze this photo.").check();
    const started = Date.now();
    await page
      .getByLabel("Choose a clothing photo", { exact: true })
      .setInputFiles(resolve("tests/fixtures/public-shirt.jpg"));
    await page
      .getByText("Review 1 detected items", { exact: true })
      .waitFor({ timeout: 250000 });
    await mkdir("docs/verification", { recursive: true });
    await page.screenshot({
      path: "docs/verification/live-upload.png",
      fullPage: true,
    });
    await page.getByLabel("Details checked").check();
    await page
      .getByRole("button", { name: "Add 1 items to my wardrobe" })
      .click();
    await page.getByText(/ALL CHANGES SAVED/).waitFor();
    await page.reload();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "My wardrobe", exact: true })
      .click();
    await page.getByRole("button", { name: /Edit .*shirt/i }).waitFor();
    await page.screenshot({
      path: "docs/verification/live-wardrobe.png",
      fullPage: true,
    });
    await writeFile(
      "docs/verification/live-browser.json",
      JSON.stringify(
        {
          passed: true,
          seconds: (Date.now() - started) / 1000,
          checks: [
            "real browser file normalization",
            "local vision detection",
            "review confirmation",
            "save",
            "reload persistence",
          ],
        },
        null,
        2,
      ),
    );
    console.log("Live browser upload, review, save and reload passed.");
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
