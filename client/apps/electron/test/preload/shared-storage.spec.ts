// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, vi } from "vitest";
import type { SharedStorageChanges } from "@myoxus/desktop-api-contract";

const bridge = vi.hoisted(() => ({
  listeners: new Map<string, (changes: SharedStorageChanges) => void>(),
  invoke: vi.fn(async () => ({})),
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: bridge.invoke } }));
vi.mock("../../src/preload/electron-api", () => ({
  events: {
    sharedStorage: Object.fromEntries(
      ["onGlobalStateChanged", "onGlobalCacheChanged"].map((channel) => [
        channel,
        (listener: (changes: SharedStorageChanges) => void) => {
          bridge.listeners.set(channel, listener);
          return () => bridge.listeners.delete(channel);
        },
      ]),
    ),
  },
}));

test("subscribes shared storage and projects other-frame updates in revision order", async () => {
  const { sharedStorage } = await import("../../src/preload/shared-storage");
  await Promise.all([
    sharedStorage.globalState.ready,
    sharedStorage.globalCache.ready,
  ]);
  for (const [area, channel] of [
    [sharedStorage.globalState, "onGlobalStateChanged"],
    [sharedStorage.globalCache, "onGlobalCacheChanged"],
  ] as const) {
    const changed = vi.fn();
    const stop = area.watch("theme", changed);
    const receive = bridge.listeners.get(channel);
    expect(receive).toBeDefined();
    receive!({ theme: { v: "dark", r: 2, s: "another-frame" } });
    expect(area.get("theme")).toBe("dark");
    expect(changed).toHaveBeenLastCalledWith("dark");
    receive!({ theme: { v: "light", r: 1, s: "another-frame" } });
    expect(area.get("theme")).toBe("dark");
    stop();
    changed.mockClear();
    receive!({ theme: { v: "light", r: 3, s: "another-frame" } });
    expect(changed).not.toHaveBeenCalled();
  }
});
