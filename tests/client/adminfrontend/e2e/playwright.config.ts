import path from "node:path";

import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Playwright configuration for Myoxus E2E team tests.
 *
 * Targets the running selfhost stack at localhost:3010 (frontend) and
 * localhost:3001 (API). Set reuseExistingServer: true so tests run
 * against an already-started stack without trying to launch one.
 *
 * Run: npx playwright test --config tests/client/adminfrontend/e2e/playwright.config.ts
 */
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  globalSetup: path.join(__dirname, "global-setup.ts"),
  fullyParallel: false,
  // Each test file sets up its own data; worker count 1 avoids cross-file race
  // conditions on shared admin state (team names, etc.).
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
    // The admin frontend lives under /adminfrontend. Cookie scope is the whole
    // origin, so a single browser context can hold the session cookie.
    ignoreHTTPSErrors: true,
  },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  // No webServer block: tests assume the stack is already running.
  // Start it with: cd build/server && docker compose -f docker-compose.selfhost.yml up
};

export default config;
