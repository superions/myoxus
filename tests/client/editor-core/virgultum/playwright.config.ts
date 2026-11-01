import process from "node:process";

import { testResultDir } from "@myoxus-test/kit/playwright";
import { defineConfig, type PlaywrightWorkerOptions } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: testResultDir,
  timeout: process.env.CI ? 40000 : 999999,
  fullyParallel: true,
  snapshotDir: "snapshots",
  snapshotPathTemplate: "snapshots/{testFilePath}/{arg}{ext}",
  webServer: {
    command: process.env.CI
      ? "yarn workspace @virgultum/integration-test exec vite build && yarn workspace @virgultum/integration-test exec vite preview --host 0.0.0.0"
      : "yarn workspace @virgultum/integration-test run dev --host 0.0.0.0",
    reuseExistingServer: !process.env.CI,
    env: {
      COVERAGE: process.env.COVERAGE ?? "",
    },
    url: process.env.CI ? "http://localhost:4173" : "http://localhost:5173",
  },
  use: {
    browserName:
      (process.env.BROWSER as PlaywrightWorkerOptions["browserName"]) ??
      "chromium",
    viewport: { width: 960, height: 900 },
    // Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer
    // You can open traces locally(`npx playwright show-trace trace.zip`)
    // or in your browser on [Playwright Trace Viewer](https://trace.playwright.dev/).
    trace: "on-first-retry",
    // Record video only when retrying a test for the first time.
    video: "on-first-retry",
    // Timeout for each action
    actionTimeout: 5_000,
    colorScheme: "light",
    timezoneId: "Asia/Tokyo",
    permissions:
      process.env.BROWSER && process.env.BROWSER !== "chromium"
        ? []
        : ["clipboard-read", "clipboard-write"],
  },
  workers: "80%",
  retries: process.env.CI ? 3 : 0,
  // 'github' for GitHub Actions CI to generate annotations, plus a concise 'dot'
  // default 'list' when running locally
  // See https://playwright.dev/docs/test-reporters#github-actions-annotations
  reporter: process.env.CI ? "github" : "list",
});
