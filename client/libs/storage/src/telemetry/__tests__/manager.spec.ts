import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TelemetryManager } from "../manager";
import type { TelemetryContext, TelemetryEvent } from "../types";
import { TelemetryQueue } from "../queue";

const managers: TelemetryManager[] = [];
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllGlobals();
});

const context: TelemetryContext = {
  isAuthed: false,
  isSelfHosted: false,
  channel: "stable",
  serverBaseUrl: "https://example.com",
};

const baseEvent: TelemetryEvent = {
  schemaVersion: 1,
  eventName: "openDoc",
  clientId: "client-1",
  eventId: "event-1",
};

test("telemetry manager retries with backoff and flushes on success", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "fail",
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, accepted: 1, dropped: 0 }),
    });

  globalThis.fetch = fetchMock as any;
  (globalThis as any).BUILD_CONFIG = { appVersion: "test" };

  const manager = new TelemetryManager({
    retryBaseMs: 10,
    retryMaxMs: 10,
    maxBatchEvents: 5,
  });
  managers.push(manager);
  await manager.setContext(context);

  await manager.track(baseEvent);
  const first = await manager.flush();
  expect(first.ok).toBe(false);
  expect(manager.getQueueState().size).toBe(1);
  expect(manager.getQueueState().nextRetryAt).toBeDefined();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(manager.getQueueState().size).toBe(0);
  });
});

test("telemetry queue caps entries and drops oldest", async () => {
  const queue = new TelemetryQueue(2, 10_000);
  try {
    for (const eventId of ["event-1", "event-2", "event-3"]) {
      await queue.enqueue({ ...baseEvent, eventId }, context.serverBaseUrl);
    }
    expect((await queue.peek(3)).map((item) => item.event.eventId)).toEqual([
      "event-2",
      "event-3",
    ]);
  } finally {
    await queue.close();
  }
});

test("server switch cannot deliver queued events or identity to another server", async () => {
  const fetchMock = vi.fn(async (url: URL) => ({
    ok: url.origin === "https://second.example",
    status: 503,
    text: async () => "offline",
    json: async () => ({ ok: true, accepted: 1, dropped: 0 }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("BUILD_CONFIG", { appVersion: "test" });
  const manager = new TelemetryManager({ retryBaseMs: 60_000 });
  managers.push(manager);
  await manager.setContext({ ...context, userId: "first-user" });
  await manager.track({ ...baseEvent, eventId: "first-event" });
  expect((await manager.flush()).ok).toBe(false);
  await manager.setContext({
    ...context,
    serverBaseUrl: "https://second.example",
    userId: "second-user",
  });
  await manager.track({ ...baseEvent, eventId: "second-event" });
  await vi.waitFor(() => expect(manager.getQueueState().size).toBe(0));
  const secondCalls = fetchMock.mock.calls.filter(
    ([url]) => url.origin === "https://second.example",
  );
  expect(secondCalls).toHaveLength(1);
  const request = secondCalls[0] as unknown as [URL, RequestInit];
  expect(JSON.parse(request[1].body as string).events).toEqual([
    expect.objectContaining({ eventId: "second-event", userId: "second-user" }),
  ]);
});

test("no selected or enabled server means no telemetry request or queue", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const manager = new TelemetryManager();
  managers.push(manager);
  expect(await manager.track(baseEvent)).toEqual({ queued: false });
  expect(manager.getQueueState().size).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});
