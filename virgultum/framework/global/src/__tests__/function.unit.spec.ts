/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { nextTick } from "../utils/function";

describe("nextTick", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("prefers the browser scheduler when yield is available", async () => {
    const yieldTask = vi.fn().mockResolvedValue("yielded");
    vi.stubGlobal("scheduler", { yield: yieldTask });

    await expect(nextTick()).resolves.toBe("yielded");
    expect(yieldTask).toHaveBeenCalledOnce();
  });

  test("uses requestIdleCallback when the scheduler is unavailable", async () => {
    Reflect.deleteProperty(window, "scheduler");
    const requestIdle = vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 1 });
      return 1;
    });
    vi.stubGlobal("requestIdleCallback", requestIdle);

    await nextTick();

    expect(requestIdle).toHaveBeenCalledOnce();
  });

  test("falls back to a zero-delay timer without browser scheduling APIs", async () => {
    Reflect.deleteProperty(window, "scheduler");
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.useFakeTimers();

    const pendingTick = nextTick();
    await vi.runAllTimersAsync();

    await expect(pendingTick).resolves.toBeUndefined();
  });
});
