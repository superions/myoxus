// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";

import { expect, test } from "@playwright/test";

import { startProcess } from "../../../../../client/apps/electron/scripts/lib/process";
import {
  packagedEnvironment,
  removeDirectory,
  resolvePackagedLaunch,
} from "../fixtures/packaged-runtime";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const PROFILE = path.join(
  REPO_ROOT,
  "output/electron-build/P-ELECTRON-BUILD-04/profiles/normal-quit",
);

test.describe("packaged Electron normal quit lifecycle", () => {
  test("exits without a crash signal", async () => {
    await removeDirectory(PROFILE);
    const launch = await resolvePackagedLaunch();
    const runtime = startProcess({
      args: [`--user-data-dir=${PROFILE}`, "--no-first-run"],
      command: launch.command,
      cwd: path.dirname(launch.command),
      env: packagedEnvironment({
        MYOXUS_ELECTRON_E2E_QUIT_AFTER_READY: "1",
      }),
      stdio: "pipe",
      timeoutMs: 30_000,
    });
    runtime.child.stdout?.resume();
    runtime.child.stderr?.resume();

    try {
      await runtime.completion;
      expect(runtime.child.exitCode).toBe(0);
      expect(runtime.child.signalCode).toBeNull();
    } finally {
      await runtime.stop("packaged normal quit test complete");
      await removeDirectory(PROFILE);
    }
  });
});
