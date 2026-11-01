// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  fork: vi.fn(),
  windows: [] as any[],
  channels: [] as any[],
  failLoad: false,
}));
vi.mock("electron", () => ({
  utilityProcess: { fork: runtime.fork },
  app: {},
  dialog: {},
  shell: {},
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    loadURL = vi.fn(() =>
      runtime.failLoad
        ? Promise.reject(new Error("load failed"))
        : Promise.resolve(),
    );
    destroy = vi.fn(() => this.emit("closed"));
    constructor() {
      super();
      runtime.windows.push(this);
    }
  },
  MessageChannelMain: class {
    port1 = { close: vi.fn() };
    port2 = { close: vi.fn() };
    constructor() {
      runtime.channels.push(this);
    }
  },
}));
vi.mock("../../src/main/cleanup", () => ({
  beforeAppQuit: vi.fn(),
  isAppQuitInProgress: () => false,
}));
vi.mock("../../src/main/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../src/main/renderer-arguments", () => ({
  getRendererAdditionalArguments: async () => [],
}));
vi.mock("../../src/main/web-preferences", () => ({
  buildWebPreferences: () => ({}),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  runtime.failLoad = false;
  runtime.windows.length = 0;
  runtime.channels.length = 0;
});
afterEach(() => vi.useRealTimers());

function processFixture() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    postMessage: vi.fn(),
  });
}

describe("bounded desktop startup", () => {
  it.each(["timeout"])(
    "rejects Helper %s and permits the next startup",
    async (kind) => {
      const failed = processFixture();
      const next = processFixture();
      runtime.fork.mockReturnValueOnce(failed).mockReturnValueOnce(next);
      const { ensureHelperProcess } =
        await import("../../src/main/helper-process");
      const pending = ensureHelperProcess();
      const rejection = expect(pending).rejects.toThrow();
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else failed.emit(kind, kind === "error" ? new Error("spawn denied") : 1);
      await rejection;
      const success = ensureHelperProcess();
      next.emit("spawn");
      await expect(success).resolves.toBeDefined();
    },
  );

  it.each(["timeout"])(
    "releases failed worker %s and reconnects",
    async (kind) => {
      const helper = processFixture();
      runtime.fork.mockReturnValue(helper);
      const { ensureHelperProcess } =
        await import("../../src/main/helper-process");
      const ready = ensureHelperProcess();
      helper.emit("spawn");
      await ready;
      const { WorkerManager } = await import("../../src/main/worker/pool");
      const renderer = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
      });
      const manager = new WorkerManager();
      runtime.failLoad = kind === "load";
      const pending = manager.connectWorker("doc", "port", renderer as never);
      const rejection = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      const window = runtime.windows[0];
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else if (kind === "closed") window.emit("closed");
      await rejection;
      expect(manager.workers.size).toBe(0);
      expect(runtime.channels[0].port1.close).toHaveBeenCalledOnce();
      expect(runtime.channels[0].port2.close).toHaveBeenCalledOnce();
      runtime.failLoad = false;
      const connected = manager.connectWorker("doc", "next", renderer as never);
      await vi.advanceTimersByTimeAsync(0);
      runtime.windows[1].webContents.emit("did-finish-load");
      await expect(connected).resolves.toMatchObject({ portId: "next" });
      manager.disconnectWorker("doc", "next");
      expect(manager.workers.size).toBe(0);
    },
  );
});
