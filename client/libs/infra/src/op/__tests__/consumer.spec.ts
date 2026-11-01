import { Observable } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpConsumer } from "../consumer";
import { type MessageHandlers, transfer } from "../message";
import type { OpSchema } from "../types";

interface TestOps extends OpSchema {
  add: [{ a: number; b: number }, number];
  any: [any, any];
}

declare module "vitest" {
  interface TestContext {
    consumer: OpConsumer<TestOps>;
    peerPort: MessagePort;
    handlers: MessageHandlers;
    postMessage: ReturnType<typeof vi.fn>;
  }
}

describe("op consumer", () => {
  beforeEach((ctx) => {
    const { port1, port2 } = new MessageChannel();
    ctx.peerPort = port1;
    // @ts-expect-error patch postMessage
    port2.postMessage = vi.fn(port2.postMessage);
    // @ts-expect-error patch postMessage
    ctx.postMessage = port2.postMessage;
    ctx.consumer = new OpConsumer(port2);
    // @ts-expect-error internal api
    ctx.handlers = ctx.consumer.handlers;
    vi.useFakeTimers();
  });

  afterEach((ctx) => {
    ctx.consumer.destroy();
    ctx.peerPort.close();
    vi.useRealTimers();
  });

  it("should throw if no handler registered", async (ctx) => {
    ctx.handlers.call({ type: "call", id: "add:1", name: "add", payload: {} });
    await vi.advanceTimersToNextTimerAsync();
    expect(ctx.postMessage.mock.lastCall).toMatchInlineSnapshot(`
      [
        {
          "error": {
            "message": "Handler for operation [add] is not registered.",
            "name": "Error",
          },
          "id": "add:1",
          "type": "return",
        },
      ]
    `);
  });

  it("should handle call message", async (ctx) => {
    ctx.consumer.register("add", ({ a, b }) => a + b);

    ctx.handlers.call({
      type: "call",
      id: "add:1",
      name: "add",
      payload: { a: 1, b: 2 },
    });
    await vi.advanceTimersToNextTimerAsync();
    expect(ctx.postMessage.mock.calls[0][0]).toMatchInlineSnapshot(`
      {
        "data": 3,
        "id": "add:1",
        "type": "return",
      }
    `);
  });

  it("should handle cancel message", async (ctx) => {
    ctx.consumer.register("add", ({ a, b }, { signal }) => {
      const { reject, resolve, promise } = Promise.withResolvers<number>();

      signal?.addEventListener("abort", () => {
        reject(new Error("canceled"));
      });

      setTimeout(() => {
        resolve(a + b);
      }, Number.MAX_SAFE_INTEGER);

      return promise;
    });

    ctx.handlers.call({
      type: "call",
      id: "add:1",
      name: "add",
      payload: { a: 1, b: 2 },
    });
    ctx.handlers.cancel({ type: "cancel", id: "add:1" });

    await vi.advanceTimersByTimeAsync(1);

    expect(ctx.postMessage).not.toBeCalled();
  });

  it("should transfer transferables in return", async (ctx) => {
    const data = new Uint8Array([1, 2, 3]);
    const nonTransferred = new Uint8Array([4, 5, 6]);

    ctx.consumer.register("any", () => {
      return transfer({ data: { data, nonTransferred } }, [data.buffer]);
    });

    ctx.handlers.call({ type: "call", id: "any:1", name: "any", payload: {} });
    await vi.advanceTimersToNextTimerAsync();
    expect(ctx.postMessage).toHaveBeenCalledOnce();

    expect(data.byteLength).toBe(0);
    expect(nonTransferred.byteLength).toBe(3);
  });

  it("should handle subscribe message", async (ctx) => {
    ctx.consumer.register("any", (data) => {
      return new Observable((observer) => {
        data.forEach((v: number) => observer.next(v));
        observer.complete();
      });
    });

    ctx.handlers.subscribe({
      type: "subscribe",
      id: "any:1",
      name: "any",
      payload: transfer(new Uint8Array([1, 2, 3]), [
        new Uint8Array([1, 2, 3]).buffer,
      ]),
    });
    await vi.advanceTimersToNextTimerAsync();
    expect(ctx.postMessage.mock.calls.map((call) => call[0]))
      .toMatchInlineSnapshot(`
      [
        {
          "data": 1,
          "id": "any:1",
          "type": "next",
        },
        {
          "data": 2,
          "id": "any:1",
          "type": "next",
        },
        {
          "data": 3,
          "id": "any:1",
          "type": "next",
        },
        {
          "id": "any:1",
          "type": "complete",
        },
      ]
    `);
  });

  it("should handle unsubscribe message", async (ctx) => {
    ctx.consumer.register("any", (data) => {
      return new Observable((observer) => {
        data.forEach((v: number) => {
          setTimeout(() => {
            observer.next(v);
          }, 1);
        });
        setTimeout(() => {
          observer.complete();
        }, 1);
      });
    });

    ctx.handlers.subscribe({
      type: "subscribe",
      id: "any:1",
      name: "any",
      payload: transfer(new Uint8Array([1, 2, 3]), [
        new Uint8Array([1, 2, 3]).buffer,
      ]),
    });

    ctx.handlers.unsubscribe({ type: "unsubscribe", id: "any:1" });

    await vi.advanceTimersToNextTimerAsync();
    expect(ctx.postMessage.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "id": "any:1",
            "type": "complete",
          },
        ],
      ]
    `);
  });
  it.for(["call", "subscribe"] as const)(
    "releases failed %s operations before a later cancellation",
    (kind, ctx) => {
      let signal: AbortSignal | undefined;
      ctx.consumer.register("any", (_payload, context) => {
        signal = context.signal;
        throw new Error("operation failed");
      });
      if (kind === "call") {
        ctx.handlers.call({
          type: "call",
          id: "failed",
          name: "any",
          payload: {},
        });
      } else {
        ctx.handlers.subscribe({
          type: "subscribe",
          id: "failed",
          name: "any",
          payload: {},
        });
      }
      expect(ctx.postMessage.mock.lastCall?.[0].error.message).toBe(
        "operation failed",
      );
      ctx.handlers.cancel({ type: "cancel", id: "failed" });
      expect(signal?.aborted).toBe(false);
    },
  );
});
