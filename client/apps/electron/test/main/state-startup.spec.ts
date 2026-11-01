// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  app: null as any,
  state: { all: vi.fn(), set: vi.fn(), flush: vi.fn() },
  cache: { all: vi.fn(), flush: vi.fn() },
  requestClose: vi.fn(),
}));
vi.mock("electron", () => ({
  get app() {
    return runtime.app;
  },
}));
vi.mock("../../src/main/shared-storage/storage", () => ({
  globalStateStorage: runtime.state,
  globalCacheStorage: runtime.cache,
}));
vi.mock("../../src/main/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/main/close-admission", () => ({
  rendererCloseAdmission: { request: runtime.requestClose },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  runtime.state.all.mockReturnValue({});
  runtime.cache.all.mockReturnValue({});
  runtime.requestClose.mockReset().mockResolvedValue(true);
});

it.each(["state", "cache"])(
  "quits without resets or flushes after %s load fails",
  async (file) => {
    runtime[file as "state" | "cache"].all.mockImplementationOnce(() => {
      throw new Error("load failed");
    });
    const { initializeDesktopState } = await import("../../src/main/cleanup");
    expect(initializeDesktopState).toThrow("load failed");
    runtime.app.emit("before-quit", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(runtime.app.quit).toHaveBeenCalledOnce());
    expect(runtime.state.set).not.toHaveBeenCalled();
    expect(runtime.state.flush).not.toHaveBeenCalled();
    expect(runtime.cache.flush).not.toHaveBeenCalled();
  },
);

it("vetoes quit before cleanup and never arms a canceled relaunch for a later quit", async () => {
  const decision = Promise.withResolvers<boolean>();
  runtime.requestClose.mockReturnValueOnce(decision.promise);
  const {
    initializeDesktopState,
    beforeAppQuit,
    quitAfterAdmission,
    isAppQuitInProgress,
  } = await import("../../src/main/cleanup");
  initializeDesktopState();
  const cleanup = vi.fn(),
    relaunch = vi.fn(),
    unrelatedAction = vi.fn();
  beforeAppQuit(cleanup);
  const first = quitAfterAdmission(relaunch);
  expect(quitAfterAdmission(unrelatedAction)).toBe(first);
  expect(cleanup).not.toHaveBeenCalled();
  expect(isAppQuitInProgress()).toBe(false);
  decision.resolve(false);
  await expect(first).resolves.toBe(false);
  expect(relaunch).not.toHaveBeenCalled();
  expect(runtime.state.flush).not.toHaveBeenCalled();
  expect(runtime.cache.flush).not.toHaveBeenCalled();
  await expect(quitAfterAdmission(() => runtime.app.quit())).resolves.toBe(
    true,
  );
  expect(cleanup).toHaveBeenCalledOnce();
  expect(runtime.state.flush).toHaveBeenCalledOnce();
  expect(runtime.cache.flush).toHaveBeenCalledOnce();
  expect(runtime.app.quit).toHaveBeenCalledOnce();
  expect(relaunch).not.toHaveBeenCalled();
  expect(unrelatedAction).not.toHaveBeenCalled();
  expect(isAppQuitInProgress()).toBe(true);
  const event = { preventDefault: vi.fn() };
  runtime.app.emit("before-quit", event);
  expect(event.preventDefault).not.toHaveBeenCalled();
});
