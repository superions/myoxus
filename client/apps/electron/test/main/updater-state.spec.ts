// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({
  updater: null as any,
  disabled: false,
  reason: "externally-managed",
  platform: "linux",
  admitted: true,
}));
vi.mock("electron", () => ({
  app: { on: vi.fn(), getVersion: () => "0.41.19" },
}));
vi.mock("../../src/main/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/main/cleanup", () => ({
  quitAfterAdmission: vi.fn(async (action: () => void) => {
    if (runtime.admitted) action();
    return runtime.admitted;
  }),
}));
vi.mock("../../src/main/updater/desktop-updater-port", () => ({
  selectDesktopUpdater: () =>
    runtime.disabled
      ? { state: "disabled", reason: runtime.reason }
      : {
          state: "enabled",
          updater: runtime.updater,
          target: {
            platform: runtime.platform,
            arch: "x64",
            backend: runtime.platform === "win32" ? "nsis" : "deb",
          },
        },
}));

beforeEach(() => {
  vi.resetModules();
  runtime.disabled = false;
  runtime.reason = "externally-managed";
  runtime.platform = "linux";
  runtime.admitted = true;
  process.env.NODE_ENV = "production";
  runtime.updater = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdates: vi.fn(async () => {
      runtime.updater.emit("update-not-available", { version: "0.41.19" });
      return { updateInfo: { version: "0.41.19" } };
    }),
    downloadUpdate: vi.fn(),
  });
});

describe("normal released channel policy and truthful update state", () => {
  it.each(["stable"])(
    "enables ordinary %s without fixture feed",
    async (channel) => {
      process.env.BUILD_TYPE = channel;
      const updater = await import("../../src/main/updater/electron-updater");
      await updater.registerUpdater();
      expect(updater.getUpdaterState().availability).toEqual({
        state: "enabled",
      });
      expect(updater.getUpdaterState().progress).toBeNull();
      expect(updater.getConfig()).toEqual({
        autoCheckUpdate: true,
        autoDownloadUpdate: true,
      });
      expect(runtime.updater.setFeedURL).toHaveBeenCalledWith(
        expect.objectContaining({ channel }),
      );
      await expect(updater.checkForUpdates()).resolves.toEqual({
        state: "checked",
        version: null,
      });
      expect(updater.getUpdaterState().phase).toBe("latest");
    },
  );
  it("retains available state, clears failed progress and permits download retry", async () => {
    process.env.BUILD_TYPE = "stable";
    const updater = await import("../../src/main/updater/electron-updater");
    await updater.registerUpdater();
    updater.setConfig({ autoDownloadUpdate: false, autoCheckUpdate: false });
    runtime.updater.emit("update-available", { version: "0.42.0" });
    runtime.updater.downloadUpdate.mockRejectedValueOnce(
      new Error("network failed"),
    );
    await expect(updater.downloadUpdate()).rejects.toThrow("network failed");
    expect(updater.getUpdaterState()).toMatchObject({
      phase: "error",
      progress: null,
      available: { version: "0.42.0" },
    });
    runtime.updater.downloadUpdate.mockImplementationOnce(async () => {
      runtime.updater.emit("update-downloaded", { version: "0.42.0" });
    });
    await updater.downloadUpdate();
    expect(updater.getUpdaterState()).toMatchObject({
      phase: "ready",
      progress: null,
      ready: { version: "0.42.0" },
    });
    expect(runtime.updater.downloadUpdate).toHaveBeenCalledTimes(2);
  });
  it.each(["externally-managed", "external-macos-install"])(
    "does not check or download for %s",
    async (reason) => {
      process.env.BUILD_TYPE = "internal";
      runtime.disabled = true;
      runtime.reason = reason;
      const updater = await import("../../src/main/updater/electron-updater");
      await updater.registerUpdater();
      await expect(updater.checkForUpdates()).resolves.toEqual({
        state: "unavailable",
        reason,
      });
      await updater.downloadUpdate();
      expect(runtime.updater.checkForUpdates).not.toHaveBeenCalled();
      expect(runtime.updater.downloadUpdate).not.toHaveBeenCalled();
    },
  );
  it.each(["win32", "linux"])(
    "activates %s only after admission, with silent NSIS restart",
    async (platform) => {
      runtime.platform = platform;
      const updater = await import("../../src/main/updater/electron-updater");
      await updater.registerUpdater();
      await updater.quitAndInstall();
      expect(runtime.updater.quitAndInstall).not.toHaveBeenCalled();
      runtime.updater.emit("update-downloaded", { version: "0.42.0" });
      runtime.admitted = false;
      await updater.quitAndInstall();
      expect(runtime.updater.quitAndInstall).not.toHaveBeenCalled();
      runtime.admitted = true;
      await updater.quitAndInstall();
      expect(runtime.updater.quitAndInstall.mock.calls).toEqual([
        platform === "win32" ? [true, true] : [],
      ]);
    },
  );
});
