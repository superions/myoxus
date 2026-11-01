import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Browser Web editor-host flow tests.
 *
 * These tests require the running live stack and exercise Virgultum blocks from
 * the Browser Web shell. They are intentionally not part of `web.smoke`: editor
 * interaction depth and screenshot evidence make them explicit closeout gates.
 *
 * Run a phase-owned spec through build/scripts/server/playwright-web-editor-flow.sh.
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
