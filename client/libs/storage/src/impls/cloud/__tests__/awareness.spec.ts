import { beforeEach, expect, test, vi } from "vitest";

import type { ConnectionStatus } from "../../../connection";
import { CloudAwarenessStorage } from "../awareness";
import type { SocketConnection } from "../socket";

function fakeSocket() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    connected: true,
    emit: vi.fn(),
    emitWithAck: vi.fn(async () => ({
      data: { clientId: "peer", success: true },
    })),
    on(name: string, cb: (value: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
    },
    off(name: string, cb: (value: unknown) => void) {
      listeners.get(name)?.delete(cb);
    },
    receive(name: string, value: unknown) {
      for (const cb of listeners.get(name) ?? []) cb(value);
    },
    count(name: string) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}
const scope = { spaceType: "userspace", spaceId: "owner", docId: "settings" };
const record = { docId: scope.docId, bin: new Uint8Array([1, 2, 3]) };
let socket: ReturnType<typeof fakeSocket>;
let storage: CloudAwarenessStorage;
let status: ConnectionStatus;
let callbacks: Set<(status: ConnectionStatus) => void>;
function changeStatus(next: ConnectionStatus) {
  status = next;
  for (const cb of callbacks) cb(next);
}
async function flush() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
  socket = fakeSocket();
  status = "connected";
  callbacks = new Set();
  storage = new CloudAwarenessStorage({
    isSelfHosted: true,
    serverBaseUrl: "http://awareness-contract.test",
    type: "userspace",
    id: scope.spaceId,
  });
  storage.connection = {
    get status() {
      return status;
    },
    get inner() {
      if (status !== "connected") throw new Error("connection unavailable");
      return { socket };
    },
    onStatusChanged(cb: (status: ConnectionStatus) => void) {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  } as unknown as SocketConnection;
});

test("reconnect owns exactly one listener and only consumes the subscribed scope", async () => {
  const update = vi.fn();
  const collect = vi.fn(async () => record);
  const off = storage.subscribeUpdate(scope.docId, update, collect);
  await flush();
  expect(socket.emit).toHaveBeenCalledWith(
    "space:update-awareness",
    expect.objectContaining({ ...scope, awarenessUpdate: "AQID" }),
  );
  for (let i = 0; i < 3; i++) {
    changeStatus("error");
    expect(socket.count("space:collect-awareness")).toBe(0);
    changeStatus("connected");
    await flush();
  }
  expect(socket.count("space:collect-awareness")).toBe(1);
  expect(socket.count("space:broadcast-awareness-update")).toBe(1);
  collect.mockClear();
  const payload = { ...scope, awarenessUpdate: "AQID" };
  for (const wrong of [
    { ...payload, spaceType: "workspace" },
    { ...payload, spaceId: "another-owner" },
    { ...payload, docId: "another-doc" },
  ]) {
    socket.receive("space:broadcast-awareness-update", wrong);
    socket.receive("space:collect-awareness", wrong);
  }
  expect(update).not.toHaveBeenCalled();
  expect(collect).not.toHaveBeenCalled();
  socket.receive("space:broadcast-awareness-update", payload);
  expect(update.mock.calls).toEqual([[record]]);
  socket.receive("space:collect-awareness", scope);
  await flush();
  expect(collect).toHaveBeenCalledTimes(1);
  expect(socket.emit).toHaveBeenCalledWith(
    "space:update-awareness",
    expect.objectContaining(payload),
  );
  const old = socket;
  changeStatus("error");
  socket = fakeSocket();
  changeStatus("connected");
  await flush();
  expect(old.count("space:broadcast-awareness-update")).toBe(0);
  expect(socket.count("space:broadcast-awareness-update")).toBe(1);
  socket.connected = false;
  changeStatus("closed");
  off();
  expect(socket.count("space:collect-awareness")).toBe(0);
  expect(callbacks.size).toBe(0);
});

test("a disposed subscription cannot collect after a late join ACK", async () => {
  let acknowledge!: (value: {
    data: { clientId: string; success: boolean };
  }) => void;
  socket.emitWithAck.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const off = storage.subscribeUpdate(scope.docId, vi.fn(), async () => record);
  off();
  acknowledge({ data: { clientId: "peer", success: true } });
  await flush();
  expect(
    socket.emit.mock.calls.filter(
      ([event]) => event === "space:load-awarenesses",
    ),
  ).toHaveLength(0);
  expect(socket.emit).toHaveBeenCalledWith(
    "space:leave-awareness",
    expect.objectContaining(scope),
  );
  expect(socket.count("space:collect-awareness")).toBe(0);
});

test("collection finishing after disconnect does not upload on the new socket", async () => {
  let finish!: (value: typeof record) => void;
  let collections = 0;
  const off = storage.subscribeUpdate(scope.docId, vi.fn(), () =>
    ++collections === 2
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(null),
  );
  await flush();
  const old = socket;
  old.receive("space:collect-awareness", scope);
  changeStatus("error");
  socket = fakeSocket();
  changeStatus("connected");
  finish(record);
  await flush();
  for (const target of [old, socket]) {
    expect(
      target.emit.mock.calls.filter(
        ([event]) => event === "space:update-awareness",
      ),
    ).toHaveLength(0);
  }
  off();
});

test("denied join detaches callbacks and never requests collection", async () => {
  socket.emitWithAck.mockResolvedValue({
    data: { clientId: "peer", success: false },
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const off = storage.subscribeUpdate(scope.docId, vi.fn(), async () => record);
  await flush();
  expect(error).toHaveBeenCalledWith(
    "awareness join failed",
    expect.any(Error),
  );
  expect(socket.emit).not.toHaveBeenCalled();
  expect(socket.count("space:collect-awareness")).toBe(0);
  off();
  error.mockRestore();
});

test("old disposal and late ACK never leave a replacement subscription's room", async () => {
  let acknowledge!: (value: {
    data: { clientId: string; success: boolean };
  }) => void;
  socket.emitWithAck.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const first = storage.subscribeUpdate(
    scope.docId,
    vi.fn(),
    async () => record,
  );
  const second = storage.subscribeUpdate(
    scope.docId,
    vi.fn(),
    async () => record,
  );
  first();
  first();
  acknowledge({ data: { clientId: "peer", success: true } });
  await flush();
  expect(
    socket.emit.mock.calls.filter(
      ([event]) => event === "space:leave-awareness",
    ),
  ).toHaveLength(0);
  expect(socket.count("space:broadcast-awareness-update")).toBe(1);
  second();
  expect(
    socket.emit.mock.calls.filter(
      ([event]) => event === "space:leave-awareness",
    ),
  ).toHaveLength(1);
  expect(socket.count("space:broadcast-awareness-update")).toBe(0);
});
