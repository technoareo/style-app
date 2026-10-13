import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    channel: process.env.CI ? undefined : "chrome",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
