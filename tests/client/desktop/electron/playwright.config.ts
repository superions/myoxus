// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";

import { defineConfig } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../../../..");
const phaseOutput = path.join(
  repoRoot,
  "output/electron-build/P-ELECTRON-BUILD-04",
);
const testOutput = process.env.MYOXUS_LINUX_PACKAGE_EVIDENCE
  ? path.resolve(process.env.MYOXUS_LINUX_PACKAGE_EVIDENCE)
  : phaseOutput;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  outputDir: path.join(testOutput, "playwright-results"),
  forbidOnly: true,
  reporter: "list",
  use: {
    actionTimeout: 15_000,
    trace: "retain-on-failure",
  },
});
