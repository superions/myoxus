/**
 * @vitest-environment happy-dom
 */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useSeekTime } from "../use-seek-time";

describe("useSeekTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not start the 60fps timer for stopped playback", () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    renderHook(() =>
      useSeekTime({
        state: "stopped",
        seekOffset: 12,
        updateTime: Date.now(),
        playbackRate: 1,
      }),
    );

    expect(intervalSpy).not.toHaveBeenCalled();
  });

  test("starts and clears the high-frequency timer only while playing", () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const { rerender, unmount } = renderHook(
      ({ state }: { state: "playing" | "paused" }) =>
        useSeekTime({
          state,
          seekOffset: 0,
          updateTime: Date.now(),
          playbackRate: 1,
        }),
      { initialProps: { state: "playing" } },
    );

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 16.67);

    rerender({ state: "paused" });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy).toHaveBeenCalledTimes(1);

    unmount();
  });
});
