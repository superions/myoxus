// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  OpClient,
  OpConsumer,
  transfer,
  type MessageCommunicapable,
} from "@myoxus/infra/op";
import { beforeEach, expect, test, vi } from "vitest";
import { DummyConnection } from "../connection";
import { DummyDocStorage } from "../storage/dummy/doc";
import { StoreManagerConsumer } from "../worker/consumer";
import type { WorkerManagerOps, WorkerOps } from "../worker/ops";

const lifetime = vi.hoisted(() => ({
  next: 0,
  stopped: vi.fn(),
  barriers: new Map<number, Promise<void>>(),
  connections: new Map<number, Promise<void>>(),
  deletes: new Map<number, (id: string) => void>(),
  waited: vi.fn(),
  subscribed: vi.fn(),
  unsubscribed: vi.fn(),
}));
// Only sync teardown is delayed; pool identity, disposer claims and RPC ports
// remain the real implementation. Telemetry persistence is outside this fixture.
vi.mock("../sync", () => ({
  Sync: class {
    generation = lifetime.next;
    start() {}
    async stopAndWait() {
      lifetime.stopped(this.generation);
      await lifetime.barriers.get(this.generation);
    }
  },
}));
vi.mock("../telemetry/manager", () => ({ TelemetryManager: class {} }));

class IdentityDocStorage extends DummyDocStorage {
  static readonly identifier = "IndexedDBDocStorage";
  readonly generation = ++lifetime.next;
  private ready = false;
  private readonly deleteListeners = new Set<(id: string) => void>();
  override connection = Object.assign(new DummyConnection(), {
    waitForConnected: async (signal?: AbortSignal) => {
      lifetime.waited(this.generation);
      await lifetime.connections.get(this.generation);
      signal?.throwIfAborted();
      this.ready = true;
    },
  });

  constructor() {
    super();
    lifetime.deletes.set(this.generation, (id) => {
      for (const callback of this.deleteListeners) callback(id);
    });
  }

  subscribeDocDelete(callback: (id: string) => void) {
    if (!this.ready) throw new Error("document storage is not connected");
    lifetime.subscribed(this.generation);
    this.deleteListeners.add(callback);
    return () => {
      lifetime.unsubscribed(this.generation);
      this.deleteListeners.delete(callback);
    };
  }

  override async getDoc(docId: string) {
    return {
      docId,
      bin: new Uint8Array([this.generation]),
      timestamp: new Date(0),
    };
  }
}

beforeEach(() => {
  lifetime.next = 0;
  lifetime.stopped.mockClear();
  lifetime.barriers.clear();
  lifetime.connections.clear();
  lifetime.deletes.clear();
  lifetime.waited.mockClear();
  lifetime.subscribed.mockClear();
  lifetime.unsubscribed.mockClear();
});

function fixture(mode: "shared" | "dedicated") {
  const root = new MessageChannel();
  root.port2.start();
  // Dedicated workers expose the global message API rather than onconnect ports.
  const endpoint: MessageCommunicapable =
    mode === "shared"
      ? root.port2
      : {
          postMessage: root.port2.postMessage.bind(root.port2),
          addEventListener: root.port2.addEventListener.bind(root.port2),
          removeEventListener: root.port2.removeEventListener.bind(root.port2),
        };
  const consumer = new OpConsumer<WorkerManagerOps>(endpoint);
  new StoreManagerConsumer([IdentityDocStorage]).bindConsumer(consumer);
  const manager = new OpClient<WorkerManagerOps>(root.port1);
  const connections: Array<{
    key: string;
    client: OpClient<WorkerOps>;
    channel: MessageChannel;
  }> = [];
  return {
    manager,
    async open(key: string) {
      const channel = new MessageChannel(),
        client = new OpClient<WorkerOps>(channel.port1);
      connections.push({ key, client, channel });
      await manager.call(
        "open",
        transfer(
          {
            key: "workspace-lifecycle",
            closeKey: key,
            port: channel.port2,
            options: {
              local: {
                doc: {
                  name: IdentityDocStorage.identifier,
                  opts: {
                    id: "workspace-lifecycle",
                    flavour: "myoxus-cloud",
                    type: "workspace",
                  },
                },
              },
              remotes: {},
            },
          },
          [channel.port2],
        ),
      );
      return client;
    },
    async cleanup() {
      try {
        for (const connection of connections)
          await manager.call("close", connection.key);
      } finally {
        for (const { client, channel } of connections) {
          client.destroy();
          channel.port1.close();
          channel.port2.close();
        }
        manager.destroy();
        consumer.destroy();
        root.port1.close();
        root.port2.close();
      }
    },
  };
}
const generation = async (client: OpClient<WorkerOps>) =>
  (await client.call("docStorage.getDoc", "root"))?.bin[0];

test.each(["shared"] as const)(
  "%s RPC opens a fresh live generation during old destruction",
  async (mode) => {
    const f = fixture(mode),
      barrier = Promise.withResolvers<void>();
    let closing: Promise<unknown> | undefined;
    try {
      const first = await f.open("first");
      expect(await generation(first)).toBe(1);
      lifetime.barriers.set(1, barrier.promise);
      closing = f.manager.call("close", "first");
      await vi.waitFor(() => expect(lifetime.stopped).toHaveBeenCalledWith(1));
      await f.manager.call("close", "first"); // The old disposer is already claimed.
      const replacement = await f.open("replacement");
      expect(await generation(replacement)).toBe(2);
      barrier.resolve();
      await closing;
      expect(await generation(replacement)).toBe(2);
      const shared = await f.open("shared-replacement");
      expect(await generation(shared)).toBe(2);
      await f.manager.call("close", "replacement");
      expect(await generation(shared)).toBe(2);
      expect(
        lifetime.stopped.mock.calls.filter(([id]) => id === 1),
      ).toHaveLength(1);
      expect(
        lifetime.stopped.mock.calls.filter(([id]) => id === 2),
      ).toHaveLength(0);
      await f.manager.call("close", "shared-replacement");
      await f.manager.call("close", "shared-replacement");
      expect(
        lifetime.stopped.mock.calls.filter(([id]) => id === 2),
      ).toHaveLength(1);
    } finally {
      barrier.resolve();
      try {
        await closing;
      } finally {
        await f.cleanup();
      }
    }
  },
);

test.each(["shared"] as const)(
  "%s RPC waits for document storage before forwarding confirmed deletion",
  async (mode) => {
    const f = fixture(mode),
      barrier = Promise.withResolvers<void>();
    lifetime.connections.set(1, barrier.promise);
    const received: string[] = [],
      errors: unknown[] = [];
    let off = () => {};
    try {
      const client = await f.open("cold-delete");
      const subscription = client
        .ob$("docStorage.subscribeDocDelete")
        .subscribe({
          next: (id) => received.push(id),
          error: (error) => errors.push(error),
        });
      off = () => subscription.unsubscribe();
      await vi.waitFor(() => expect(lifetime.waited).toHaveBeenCalledWith(1));
      expect(lifetime.subscribed).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      barrier.resolve();
      await vi.waitFor(() =>
        expect(lifetime.subscribed).toHaveBeenCalledWith(1),
      );
      lifetime.deletes.get(1)!("deleted-leaf");
      await vi.waitFor(() => expect(received).toEqual(["deleted-leaf"]));
      off();
      await vi.waitFor(() =>
        expect(lifetime.unsubscribed).toHaveBeenCalledWith(1),
      );
      lifetime.deletes.get(1)!("later-leaf");
      expect(received).toEqual(["deleted-leaf"]);
      expect(errors).toEqual([]);
    } finally {
      off();
      barrier.resolve();
      await f.cleanup();
    }
  },
);

test.each(["shared"] as const)(
  "%s RPC cancellation during connection does not leave a deletion observer",
  async (mode) => {
    const f = fixture(mode),
      barrier = Promise.withResolvers<void>();
    lifetime.connections.set(1, barrier.promise);
    const received: string[] = [],
      errors: unknown[] = [];
    let off = () => {};
    try {
      const client = await f.open("cancelled-delete");
      const subscription = client
        .ob$("docStorage.subscribeDocDelete")
        .subscribe({
          next: (id) => received.push(id),
          error: (error) => errors.push(error),
        });
      off = () => subscription.unsubscribe();
      await vi.waitFor(() => expect(lifetime.waited).toHaveBeenCalledWith(1));
      off();
      // This later RPC confirms the unsubscribe message was consumed before
      // releasing readiness; there is no timer-based cancellation assumption.
      await client.call("docStorage.getDoc", "root");
      barrier.resolve();
      await client.call("docStorage.getDoc", "root");
      lifetime.deletes.get(1)!("deleted-leaf");
      expect(lifetime.subscribed).not.toHaveBeenCalled();
      expect(received).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      off();
      barrier.resolve();
      await f.cleanup();
    }
  },
);
