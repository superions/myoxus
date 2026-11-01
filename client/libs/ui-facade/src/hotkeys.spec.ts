// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";

import { createMyoxusHotkeyHandler } from "./hotkeys";

function usePlatform(platform: string) {
  vi.stubGlobal("navigator", { platform });
}

function keyboardEvent(
  options: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
) {
  return {
    altKey: false,
    code: options.key,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    ...options,
  } as unknown as KeyboardEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMyoxusHotkeyHandler", () => {
  test("maps $mod to Meta only on Apple platforms", () => {
    usePlatform("MacIntel");
    const callback = vi.fn();
    const handler = createMyoxusHotkeyHandler([["$mod+K", callback]]);

    handler(keyboardEvent({ key: "k", metaKey: true }));
    handler(keyboardEvent({ key: "k", ctrlKey: true }));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("maps $mod to Control on non-Apple platforms", () => {
    usePlatform("Linux x86_64");
    const callback = vi.fn();
    const handler = createMyoxusHotkeyHandler([["$mod+,", callback]]);

    handler(keyboardEvent({ key: ",", ctrlKey: true }));
    handler(keyboardEvent({ key: ",", metaKey: true }));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("preserves explicit physical key declarations", () => {
    usePlatform("Linux x86_64");
    const callback = vi.fn();
    const handler = createMyoxusHotkeyHandler([["Alt+KeyS", callback]]);

    handler(keyboardEvent({ altKey: true, code: "KeyS", key: "ß" }));

    expect(callback).toHaveBeenCalledOnce();
  });
});
