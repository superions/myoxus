// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, test, vi } from "vitest";
import {
  bindRecordingDeliveryLifetime,
  createRecordingCompletionTimeout,
} from "./delivery-lifetime";

test("reopening a saved recording cancels its previous dismissal and teardown cancels the last interval", () => {
  vi.useFakeTimers();
  const hide = vi.fn();
  const completion = createRecordingCompletionTimeout(hide);
  try {
    completion.schedule(42);
    vi.advanceTimersByTime(9_000);
    completion.schedule(42);
    vi.advanceTimersByTime(1_000);
    expect(hide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(9_000);
    expect(hide).toHaveBeenCalledExactlyOnceWith(42);
    expect(vi.getTimerCount()).toBe(0);
    completion.schedule(43);
    completion.clear();
    vi.advanceTimersByTime(10_000);
    expect(hide).toHaveBeenCalledExactlyOnceWith(42);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    completion.clear();
    vi.useRealTimers();
  }
});

test("a full reload or lost renderer interrupts delivery; SPA navigation and completed delivery do not", () => {
  for (const event of ["reload", "render-process-gone", "destroyed"]) {
    const sender = new EventEmitter();
    const interrupted = vi.fn();
    const dispose = bindRecordingDeliveryLifetime(
      sender as WebContents,
      interrupted,
    );
    sender.emit(
      "did-start-navigation",
      {},
      "assets://./workspace/other",
      true,
      true,
    );
    sender.emit("did-start-navigation", {}, "assets://./frame", false, false);
    expect(interrupted).not.toHaveBeenCalled();
    if (event === "reload") {
      sender.emit(
        "did-start-navigation",
        {},
        "assets://./sign-in",
        false,
        true,
      );
    } else sender.emit(event);
    expect(interrupted).toHaveBeenCalledOnce();
    dispose();
    sender.emit("destroyed");
    sender.emit("render-process-gone");
    sender.emit("did-start-navigation", {}, "assets://./", false, true);
    expect(interrupted).toHaveBeenCalledOnce();
    expect(sender.eventNames()).toEqual([]);
  }
});
