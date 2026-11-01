import { reserveAutomaticRetry } from "@myoxus/infra/retry";
import { describe, expect, test, vi } from "vitest";

import {
  type ClientUpdateControl,
  ClientUpdateGate,
  startClientUpdateControlRuntime,
} from "./client-update-control";

function control(
  overrides: Partial<ClientUpdateControl> = {},
): ClientUpdateControl {
  return {
    schemaVersion: 1,
    stateId: "state-1",
    phase: "normal",
    operationId: null,
    maxAttempts: null,
    retryAfterMs: null,
    completion: null,
    requiredWebBuildId: null,
    cacheEpoch: 0,
    updatedAt: "2026-07-26T00:00:00Z",
    ...overrides,
  };
}

describe("ClientUpdateGate", () => {
  test("blocks attempt N+1 and does not refill on a new state of the same operation", async () => {
    const gate = new ClientUpdateGate();
    await gate.read(async () =>
      control({
        phase: "limited",
        operationId: "operation-a",
        maxAttempts: 2,
      }),
    );

    expect(gate.reserveAutomaticRetry("document-sync")).toBe(true);
    expect(gate.reserveAutomaticRetry("swr")).toBe(true);
    expect(gate.reserveAutomaticRetry("connection")).toBe(false);

    await gate.read(async () =>
      control({
        stateId: "state-2",
        phase: "limited",
        operationId: "operation-a",
        maxAttempts: 2,
      }),
    );

    expect(gate.getSnapshot().remainingAttempts).toBe(0);
    expect(gate.reserveAutomaticRetry("blob-sync")).toBe(false);
  });

  test("resets a limited budget only for a different operation", async () => {
    const gate = new ClientUpdateGate();
    await gate.read(async () =>
      control({
        phase: "limited",
        operationId: "operation-a",
        maxAttempts: 1,
      }),
    );
    expect(gate.reserveAutomaticRetry("livedata")).toBe(true);

    await gate.read(async () => control({ stateId: "state-normal" }));
    await gate.read(async () =>
      control({
        stateId: "state-returned",
        phase: "limited",
        operationId: "operation-a",
        maxAttempts: 1,
      }),
    );
    expect(gate.reserveAutomaticRetry("livedata")).toBe(false);

    await gate.read(async () =>
      control({
        stateId: "state-2",
        phase: "limited",
        operationId: "operation-b",
        maxAttempts: 1,
      }),
    );
    expect(gate.reserveAutomaticRetry("livedata")).toBe(true);
  });

  test.each(["suspended", "failed"] as const)(
    "admits no automatic retries while %s",
    async (phase) => {
      const gate = new ClientUpdateGate();
      await gate.read(async () =>
        control({ phase, operationId: "operation-a" }),
      );
      expect(gate.reserveAutomaticRetry("connection")).toBe(false);
    },
  );

  test("deduplicates concurrent control reads and fails closed", async () => {
    const gate = new ClientUpdateGate();
    let resolveRead!: (value: ClientUpdateControl) => void;
    const reader = vi.fn(
      () =>
        new Promise<ClientUpdateControl>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const first = gate.read(reader);
    const second = gate.read(reader);
    expect(reader).toHaveBeenCalledOnce();
    resolveRead(control());
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await expect(
      gate.read(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(gate.getSnapshot().status).toBe("error");
    expect(gate.reserveAutomaticRetry("swr")).toBe(false);
  });
});

describe("startClientUpdateControlRuntime", () => {
  test("installs the gate for retry producers and polls only active sparse states", async () => {
    vi.useFakeTimers();
    const gate = new ClientUpdateGate();
    const reader = vi
      .fn<() => Promise<ClientUpdateControl>>()
      .mockResolvedValueOnce(
        control({
          phase: "limited",
          operationId: "operation-a",
          maxAttempts: 1,
          retryAfterMs: 5_000,
        }),
      )
      .mockResolvedValue(control({ stateId: "state-2" }));
    const stop = startClientUpdateControlRuntime({ gate, read: reader });

    await vi.runAllTicks();
    expect(reader).toHaveBeenCalledOnce();
    expect(reserveAutomaticRetry("indexer-sync")).toBe(true);
    expect(reserveAutomaticRetry("indexer-sync")).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(gate.getSnapshot()).toMatchObject({
      status: "ready",
      control: { phase: "normal" },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reader).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });

  test("polls a failed state so a lost completion wake-up still converges", async () => {
    vi.useFakeTimers();
    const gate = new ClientUpdateGate();
    const reader = vi
      .fn<() => Promise<ClientUpdateControl>>()
      .mockResolvedValueOnce(
        control({
          phase: "failed",
          operationId: "operation-a",
        }),
      )
      .mockResolvedValue(control({ stateId: "state-recovered" }));
    const stop = startClientUpdateControlRuntime({ gate, read: reader });

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(reader).toHaveBeenCalledTimes(2);
    expect(gate.getSnapshot()).toMatchObject({
      status: "ready",
      control: { phase: "normal" },
    });

    stop();
    vi.useRealTimers();
  });
});
