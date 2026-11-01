import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Playwright config for Browser Web flow tests that target the local live stack.
 *
 * Targets: localhost:3010 (frontend) and localhost:3001 (API).
 * Tests assume the stack is already running (use stack-up.sh first).
 *
 * Run: npx playwright test --config tests/client/webfrontend/flow/playwright.config.ts
 */
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  // Keep focused, owner-approved journeys inside the existing matrix suite.
  testMatch: process.env.MYOXUS_WEB_FLOW_TEST_MATCH,
  grep: process.env.MYOXUS_WEB_FLOW_GREP
    ? new RegExp(process.env.MYOXUS_WEB_FLOW_GREP)
    : undefined,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010",
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
