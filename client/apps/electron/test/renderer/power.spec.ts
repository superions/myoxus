import {
  clientEventChannelManifest,
  clientHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type PowerSourceListener = (isOnBattery: boolean) => void;

function createChannelSurface(manifest: object) {
  return Object.fromEntries(
    Object.entries(manifest).map(([namespace, channels]) => [
      namespace,
      Object.fromEntries(
        Object.keys(channels).map((channel) => [channel, vi.fn()]),
      ),
    ]),
  );
}

function createStorageArea() {
  return {
    ready: Promise.resolve(),
    keys: vi.fn(() => []),
    get: vi.fn(),
    watch: vi.fn(() => vi.fn()),
    set: vi.fn(),
    del: vi.fn(),
    clear: vi.fn(),
  };
}

describe("renderer power source bridge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "__appInfo");
    Reflect.deleteProperty(globalThis, "__apis");
    Reflect.deleteProperty(globalThis, "__events");
    Reflect.deleteProperty(globalThis, "__sharedStorage");
  });

  test("subscribes to the real __events global and applies pushed state", async () => {
    let listener: PowerSourceListener | undefined;
    const subscribe = vi.fn((next: PowerSourceListener) => {
      listener = next;
      return vi.fn();
    });

    const apis = createChannelSurface(clientHandlerChannelManifest);
    const events = createChannelSurface(clientEventChannelManifest);
    events.power["power-source"] = subscribe;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
    Reflect.set(globalThis, "__appInfo", {
      electron: true,
      scheme: "myoxus-dev",
      viewId: "test-view",
      windowName: "main",
    });
    Reflect.set(globalThis, "__apis", apis);
    Reflect.set(globalThis, "__events", events);
    Reflect.set(globalThis, "__sharedStorage", {
      globalCache: createStorageArea(),
      globalState: createStorageArea(),
    });

    const power =
      await import("../../../electron-renderer/src/app/effects/power");
    power.setupPowerSourceStore();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(power.getIsOnBatterySnapshot()).toBe(false);

    listener?.(true);
    expect(power.getIsOnBatterySnapshot()).toBe(true);
  });
});
