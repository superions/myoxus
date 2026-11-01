// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventEmitter } from "node:events";

import type { Rectangle } from "electron";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { DesktopStateStorage } from "../../src/main/shared-storage/storage";
import {
  bindMainWindowState,
  resolveMainWindowState,
} from "../../src/main/windows-manager/window-state";

function displays(primary: Rectangle, matching = primary) {
  return {
    getPrimaryDisplay: () => ({ workArea: primary }),
    getDisplayMatching: () => ({ workArea: matching }),
  };
}

function storage(flush = vi.fn(async () => undefined)) {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: <T>(key: string) => values.get(key) as T | undefined,
      set: <T>(key: string, value: T | undefined) => values.set(key, value),
      del: (key: string) => values.delete(key),
      clear: () => values.clear(),
      keys: () => [...values.keys()],
      watch: vi.fn(),
      all: () => Object.fromEntries(values),
      watchAll: vi.fn(),
      flush,
      dispose: vi.fn(async () => undefined),
    } as unknown as DesktopStateStorage,
    values,
    flush,
  };
}

class WindowTarget extends EventEmitter {
  bounds: Rectangle = { x: 40, y: 50, width: 900, height: 700 };
  maximized = false;
  fullScreen = false;

  getNormalBounds() {
    return this.bounds;
  }
  isDestroyed() {
    return false;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullScreen;
  }
}

afterEach(() => vi.useRealTimers());

describe("main window state", () => {
  test("centers the product default for fresh and malformed state", () => {
    const source = displays({ x: 100, y: 50, width: 1400, height: 900 });
    expect(resolveMainWindowState(undefined, source)).toEqual({
      bounds: { x: 300, y: 100, width: 1000, height: 800 },
      isMaximized: false,
      isFullScreen: false,
    });
    expect(
      resolveMainWindowState({ bounds: { width: "wide" } }, source),
    ).toEqual(resolveMainWindowState(undefined, source));
  });

  test("clamps a valid intersecting window to its matching work area", () => {
    const state = resolveMainWindowState(
      {
        bounds: { x: 1800, y: -40, width: 900, height: 700 },
        isMaximized: true,
        isFullScreen: false,
        ignored: "foreign field",
      },
      displays(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 1600, y: 0, width: 1200, height: 900 },
      ),
    );
    expect(state).toEqual({
      bounds: { x: 1800, y: 0, width: 900, height: 700 },
      isMaximized: true,
      isFullScreen: false,
    });
  });

  test("rejects a fully offscreen saved window instead of pinning it to an arbitrary display", () => {
    const source = displays(
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1600, y: 0, width: 1200, height: 900 },
    );
    const result = resolveMainWindowState(
      {
        bounds: { x: 9000, y: 9000, width: 900, height: 700 },
        isMaximized: true,
        isFullScreen: true,
      },
      source,
    );
    expect(result).toEqual({
      bounds: { x: 460, y: 140, width: 1000, height: 800 },
      isMaximized: false,
      isFullScreen: false,
    });
  });

  test("debounces normal bounds but persists status and flushes the latest state", async () => {
    vi.useFakeTimers();
    const target = new WindowTarget();
    const stateStorage = storage();
    const controller = bindMainWindowState(target, stateStorage.storage);

    target.bounds = { x: 80, y: 90, width: 1100, height: 800 };
    target.emit("move");
    expect(stateStorage.values.has("mainWindowState")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(stateStorage.values.get("mainWindowState")).toEqual({
      bounds: target.bounds,
      isMaximized: false,
      isFullScreen: false,
    });

    target.maximized = true;
    target.emit("maximize");
    expect(stateStorage.values.get("mainWindowState")).toMatchObject({
      isMaximized: true,
    });
    await controller.flush();
    expect(stateStorage.flush).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test("propagates a close flush failure", async () => {
    const failure = new Error("disk unavailable");
    const target = new WindowTarget();
    const stateStorage = storage(
      vi.fn(async () => {
        throw failure;
      }),
    );
    const controller = bindMainWindowState(target, stateStorage.storage);
    await expect(controller.flush()).rejects.toBe(failure);
  });
});
