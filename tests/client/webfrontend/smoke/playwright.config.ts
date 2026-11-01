import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Playwright config for web frontend smoke tests.
 *
 * Targets the running local live stack at localhost:3010.
 * Tests sign in as a real user and verify the app loads without JS errors.
 *
 * Run: npx playwright test --config tests/client/webfrontend/smoke/playwright.config.ts
 */
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3010",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    locale: "en-US",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
};

export default config;
