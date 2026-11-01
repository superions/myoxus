import { OpClient, OpConsumer } from "@myoxus/infra/op";
import { expect, test, vi } from "vitest";

import type { AwarenessRecord } from "../storage";
import type { AwarenessSync } from "../sync/awareness";
import { StoreManagerClient } from "../worker/client";
import { StoreManagerConsumer } from "../worker/consumer";
import type { WorkerManagerOps } from "../worker/ops";

const transport = vi.hoisted(() => ({
  collect: undefined as undefined | (() => Promise<unknown>),
  unsubscribe: vi.fn(),
}));
vi.mock("../sync", () => ({
  Sync: class {
    awareness = {
      subscribeUpdate(
        _id: string,
        _update: unknown,
        collect: () => Promise<unknown>,
      ) {
        transport.collect = collect;
        return transport.unsubscribe;
      },
    };
    start() {}
    async stopAndWait() {}
  },
}));
// Telemetry persistence is outside this RPC fixture; keep its DB unopened.
vi.mock("../telemetry/manager", () => ({ TelemetryManager: class {} }));

test("real worker RPC settles null, failed and cancelled Awareness collection", async () => {
  const { port1, port2 } = new MessageChannel();
  const consumer = new OpConsumer<WorkerManagerOps>(port2);
  new StoreManagerConsumer([]).bindConsumer(consumer);
  const client = new OpClient<WorkerManagerOps>(port1);
  const manager = new StoreManagerClient(client);
  const opened = manager.open("awareness-contract", { local: {}, remotes: {} });
  const sync = (opened.store as unknown as { awarenessSync: AwarenessSync })
    .awarenessSync;
  let finish: ((record: AwarenessRecord | null) => void) | undefined;
  let request = 0;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const off = sync.subscribeUpdate(
    "settings",
    () => {},
    async () => {
      if (++request === 1) return null;
      if (request === 2) throw new Error("collection failed");
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  try {
    await vi.waitFor(() => expect(transport.collect).toBeTypeOf("function"));
    await expect(transport.collect!()).resolves.toBeNull();
    await expect(transport.collect!()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(
      "error collecting awareness",
      expect.any(Error),
    );
    const pending = transport.collect!();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    off();
    await expect(pending).resolves.toBeNull();
    finish!(null);
    expect(transport.unsubscribe).toHaveBeenCalledTimes(1);
    opened.dispose();
    await client.call("close", "already-closed");
  } finally {
    off();
    manager.dispose();
    consumer.destroy();
    client.destroy();
    error.mockRestore();
  }
});
