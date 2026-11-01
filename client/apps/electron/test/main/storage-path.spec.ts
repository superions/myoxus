// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  userData: "/unresolved",
  getPath: vi.fn(() => runtime.userData),
}));

vi.mock("electron", () => ({
  app: { getPath: runtime.getPath },
}));
vi.mock("../../src/main/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => vi.resetModules());

describe("desktop state path ownership", () => {
  test("resolves userData lazily after the channel override", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-userdata-"));
    const staleDirectory = path.join(root, "stale");
    const directory = path.join(root, "active");
    try {
      runtime.userData = staleDirectory;
      runtime.getPath.mockClear();
      const { globalStateStorage } =
        await import("../../src/main/shared-storage/storage");
      expect(runtime.getPath).not.toHaveBeenCalled();

      runtime.userData = directory;
      globalStateStorage.set("onboardingState", { completed: true });
      await globalStateStorage.flush();

      expect(runtime.getPath).toHaveBeenCalledOnce();
      expect(
        JSON.parse(
          fs.readFileSync(path.join(directory, "global-state.json"), "utf8"),
        ),
      ).toEqual({ onboardingState: { completed: true } });
      expect(
        fs.existsSync(path.join(staleDirectory, "global-state.json")),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
