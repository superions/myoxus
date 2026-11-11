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
  test("transitions macOS cookie auth once and retains the replacement session across restarts", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "myoxus-cookie-policy-"),
    );
    runtime.userData = directory;
    fs.chmodSync(directory, 0o755);
    let storage = await import("../../src/main/shared-storage/storage");
    try {
      const { prepareDesktopCookieStorage } =
        await import("../../src/main/cookie-storage");
      storage.globalStateStorage.set("server-auth", { account: "previous" });
      storage.globalStateStorage.set("tabViewsMetaSchema", {
        activeWorkbenchId: "retained",
      });
      await storage.globalStateStorage.flush();

      await prepareDesktopCookieStorage("linux");
      expect(storage.globalStateStorage.get("server-auth")).toEqual({
        account: "previous",
      });
      await prepareDesktopCookieStorage("darwin");
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(storage.globalStateStorage.get("server-auth")).toBeUndefined();
      expect(storage.globalStateStorage.get("tabViewsMetaSchema")).toEqual({
        activeWorkbenchId: "retained",
      });

      storage.globalStateStorage.set("server-auth", {
        account: "signed-in-again",
      });
      await storage.globalStateStorage.flush();
      await storage.globalStateStorage.dispose();
      await storage.globalCacheStorage.dispose();
      vi.resetModules();
      storage = await import("../../src/main/shared-storage/storage");
      const restarted = await import("../../src/main/cookie-storage");
      await restarted.prepareDesktopCookieStorage("darwin");
      expect(storage.globalStateStorage.get("server-auth")).toEqual({
        account: "signed-in-again",
      });
    } finally {
      await storage.globalStateStorage.dispose();
      await storage.globalCacheStorage.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

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
