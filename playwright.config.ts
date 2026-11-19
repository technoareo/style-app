import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3000";
const baseURL = `http://127.0.0.1:${port}`;
const serverCommand = process.env.CI
  ? `npm run start -- --hostname 127.0.0.1 --port ${port}`
  : `npm run dev -- --hostname 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL,
    headless: true,
    actionTimeout: 10000,
    navigationTimeout: 15000,
    channel: process.env.CI ? undefined : "chrome",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // CI has already built the release artifact. Exercise that artifact rather
    // than Next's development toolbar, which overlaps mobile bottom navigation
    // and is never shipped to consumers.
    command: serverCommand,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
