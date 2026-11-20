import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect } from "./accounts";

const output = "docs/verification/build-038";
mkdirSync(output, { recursive: true });

for (const viewport of [
  { width: 390, height: 844, label: "iphone" },
  { width: 360, height: 800, label: "android" },
]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`review package ${viewport.label} ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      let releaseLoad!: () => void;
      const held = new Promise<void>((resolve) => (releaseLoad = resolve));
      await page.route("**/api/wardrobe", async (route) => {
        if (route.request().method() === "GET") await held;
        return route.continue();
      });
      await page.goto("/");
      await expect(page.getByText("Opening your wardrobe…")).toBeVisible();
      await page.screenshot({ path: `${output}/${viewport.label}-${colorScheme}-loading.png` });
      releaseLoad();
      await expect(page.getByText("Let’s build your first look")).toBeVisible();
      await page.screenshot({ path: `${output}/${viewport.label}-${colorScheme}-empty.png` });

      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);

      await page.unroute("**/api/wardrobe");
      await page.route("**/api/wardrobe", async (route) => {
        if (route.request().method() === "GET")
          return route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
        return route.continue();
      });
      await page.reload();
      await expect(page.getByRole("alert")).toBeVisible();
      await page.screenshot({ path: `${output}/${viewport.label}-${colorScheme}-error.png` });
    });
  }
}
