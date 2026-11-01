// @vitest-environment happy-dom
import { ElectronGlobalState } from "./electron";
import {
  writeGlobalStateConfirmed,
  readGlobalStateConfirmed,
} from "../providers/global";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AsyncStorageMemento } from "./storage";

class Channel extends EventTarget {
  static instances: Channel[] = [];
  sent: unknown[] = [];
  constructor(_name: string) {
    super();
    Channel.instances.push(this);
  }
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  close() {}
}
beforeEach(() => vi.stubGlobal("BroadcastChannel", Channel));
afterEach(() => {
  Channel.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("an older async initial read cannot overwrite a newer channel event", async () => {
  const memento = new AsyncStorageMemento("event-test", "values");
  const initial = Promise.withResolvers<number>();
  vi.spyOn(memento, "get").mockReturnValue(initial.promise);
  const received: unknown[] = [];
  const subscription = memento
    .watch("key")
    .subscribe((value) => received.push(value));
  const channel = Channel.instances[0];
  channel.dispatchEvent(
    new MessageEvent("message", { data: { key: "other", value: 99 } }),
  );
  channel.dispatchEvent(
    new MessageEvent("message", { data: { key: "key", value: 2 } }),
  );
  initial.resolve(1);
  await initial.promise;
  expect(received).toEqual([2]);
  subscription.unsubscribe();
  channel.dispatchEvent(
    new MessageEvent("message", { data: { key: "key", value: 3 } }),
  );
  expect(received).toEqual([2]);
});

test("native confirmed writes await the existing Main flush and propagate failure without optimistic replay", async () => {
  const flush = Promise.withResolvers<void>();
  const optimistic = vi.fn();
  const set = vi.fn(() => flush.promise);
  const state = new ElectronGlobalState({
    handler: { sharedStorage: { setGlobalState: set } },
    sharedStorage: {
      globalState: { ready: Promise.resolve(), set: optimistic },
    },
  } as never);
  const write = writeGlobalStateConfirmed(state, "pending", {
    requestId: "request-a",
  });
  await vi.waitFor(() =>
    expect(set).toHaveBeenCalledWith("pending", { requestId: "request-a" }),
  );
  let acknowledged = false;
  const observed = write.then(
    () => {
      acknowledged = true;
    },
    (error) => {
      throw error;
    },
  );
  const failure = expect(observed).rejects.toThrow("flush failed");
  expect(acknowledged).toBe(false);
  flush.reject(new Error("flush failed"));
  await failure;
  expect(optimistic).not.toHaveBeenCalled();
});

test("critical native reads use the typed Main snapshot and fail closed when preload readiness hid an initialization failure", async () => {
  const cached = vi.fn(() => undefined);
  const read = vi.fn(async () => {
    throw new Error("snapshot unavailable");
  });
  const state = new ElectronGlobalState({
    handler: { sharedStorage: { getAllGlobalState: read } },
    sharedStorage: { globalState: { ready: Promise.resolve(), get: cached } },
  } as never);
  await expect(readGlobalStateConfirmed(state, "pending")).rejects.toThrow(
    "snapshot unavailable",
  );
  expect(read).toHaveBeenCalledOnce();
  expect(cached).not.toHaveBeenCalled();
});

test("native confirmed deletion waits for Main acknowledgement without invoking preload's optimistic delete", async () => {
  const flush = Promise.withResolvers<void>();
  const optimistic = vi.fn();
  const remove = vi.fn(() => flush.promise);
  const state = new ElectronGlobalState({
    handler: { sharedStorage: { delGlobalState: remove } },
    sharedStorage: {
      globalState: { ready: Promise.resolve(), del: optimistic },
    },
  } as never);
  let acknowledged = false;
  const deletion = writeGlobalStateConfirmed(state, "pending", undefined).then(
    () => {
      acknowledged = true;
    },
  );
  await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("pending"));
  expect(acknowledged).toBe(false);
  flush.resolve();
  await deletion;
  expect(acknowledged).toBe(true);
  expect(optimistic).not.toHaveBeenCalled();
});
