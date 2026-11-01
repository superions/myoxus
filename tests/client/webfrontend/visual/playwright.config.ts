import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Browser Web visual evidence tests.
 *
 * This suite is opt-in evidence for UI TODOs and design closeouts. It requires
 * the running live stack, writes screenshots/reports, and must not be hidden in
 * runtime smoke or ordinary Web/Core changed-path gates.
 *
 * Run: build/scripts/test/run.sh --suite web.visual
 */
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3010",
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
