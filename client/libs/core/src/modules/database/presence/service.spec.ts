// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: focused unit tests for the database presence service.
//
// The tests run under happy-dom and use a hand-rolled fake socket
// implementation instead of pulling in `socket.io-client`. The fake
// captures every emit + handler registration so the assertions can
// replay the join / leave / focus / change sequences end-to-face.
//
// @vitest-environment happy-dom

import type { Socket } from "socket.io-client";
import { describe, expect, test, vi } from "vitest";

import {
  changeEventAffectsLocalTarget,
  DatabasePresenceService,
  deriveInteractionMode,
} from "./service";

class FakeSocket {
  public static readonly instances: FakeSocket[] = [];

  public readonly handlers = new Map<
    string,
    Array<(payload: unknown) => void>
  >();
  public readonly emits: Array<{
    name: string;
    payload: unknown;
    hasAck: boolean;
  }> = [];

  public nextAck: ((response: unknown) => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }

  emit(
    name: string,
    payload: unknown,
    ack?: (response: unknown) => void,
  ): void {
    this.emits.push({ name, payload, hasAck: typeof ack === "function" });
    if (typeof ack === "function") {
      this.nextAck = ack;
    }
  }

  on(name: string, handler: (payload: unknown) => void): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  off(name: string, handler: (payload: unknown) => void): void {
    const list = this.handlers.get(name) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
    if (this.handlers.get(name)?.length === 0) {
      this.handlers.delete(name);
    }
  }

  fire(name: string, payload: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) {
      handler(payload);
    }
  }

  ackWith(response: unknown): void {
    const ack = this.nextAck;
    this.nextAck = null;
    if (ack) ack(response);
  }
}

function makeSocket(): Socket {
  return new FakeSocket() as unknown as Socket;
}

function makeRecord(
  overrides: Partial<{
    socketId: string;
    userId: string;
    displayName: string;
    viewId: string | null;
    rowId: string | null;
    fieldId: string | null;
    dragging: boolean;
  }> = {},
) {
  return {
    socketId: overrides.socketId ?? "sid",
    userId: overrides.userId ?? "u1",
    displayName: overrides.displayName ?? "Alice",
    viewId: overrides.viewId ?? null,
    rowId: overrides.rowId ?? null,
    fieldId: overrides.fieldId ?? null,
    dragging: overrides.dragging ?? false,
    lastActiveAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("DatabasePresenceService", () => {
  test("acquire emits database:join exactly once per lifecycle", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({ data: { presence: [] } });
    service.acquire();
    service.release();
    service.acquire();
    service.release();
    service.release();
    const joins = (socket as unknown as FakeSocket).emits.filter(
      (e) => e.name === "database:join",
    );
    expect(joins).toHaveLength(1);
    const leaves = (socket as unknown as FakeSocket).emits.filter(
      (e) => e.name === "database:leave",
    );
    expect(leaves).toHaveLength(1);
  });

  test("ack with presence populates snapshot and notifies listeners", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    const listener = vi.fn();
    service.subscribePresence(listener);
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      data: {
        presence: [
          makeRecord({ socketId: "a" }),
          makeRecord({ socketId: "b", userId: "u2" }),
        ],
      },
    });
    expect(service.listPresence()).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(2);
  });

  test("ack error calls onJoinError and reports disconnected", () => {
    const socket = makeSocket();
    const onJoinError = vi.fn();
    const onConnection = vi.fn();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
      onJoinError,
    });
    service.subscribeConnection(onConnection);
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      error: { name: "DATABASE_FORBIDDEN", message: "denied" },
    });
    expect(onJoinError).toHaveBeenCalledWith({
      name: "DATABASE_FORBIDDEN",
      message: "denied",
    });
    expect(onConnection).toHaveBeenCalledWith(false);
  });

  test("presence update payload triggers notifyPresence merge", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    const listener = vi.fn();
    service.subscribePresence(listener);
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      data: { presence: [makeRecord({ socketId: "a", rowId: "r1" })] },
    });
    listener.mockClear();
    (socket as unknown as FakeSocket).fire("database:presence-update", {
      workspaceId: "w",
      databaseId: "d",
      socketId: "a",
      fieldId: "f1",
    });
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = listener.mock.calls[0][0][0];
    expect(snapshot.rowId).toBe("r1");
    expect(snapshot.fieldId).toBe("f1");
    (socket as unknown as FakeSocket).fire("database:presence-update", {
      workspaceId: "w",
      databaseId: "d",
      socketId: "a",
      viewId: null,
      rowId: null,
      fieldId: null,
    });
    expect(service.listPresence()[0]).toMatchObject({
      viewId: null,
      rowId: null,
      fieldId: null,
    });
    service.dispose();
  });

  test("presence update with left=true drops the record", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      data: {
        presence: [
          makeRecord({ socketId: "a" }),
          makeRecord({ socketId: "b" }),
        ],
      },
    });
    expect(service.listPresence()).toHaveLength(2);
    (socket as unknown as FakeSocket).fire("database:presence-update", {
      workspaceId: "w",
      databaseId: "d",
      socketId: "a",
      left: true,
    });
    expect(service.listPresence()).toHaveLength(1);
    expect(service.listPresence()[0].socketId).toBe("b");
  });

  test("presence update from a different database is ignored", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    const listener = vi.fn();
    service.subscribeUpdates(listener);
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      data: { presence: [makeRecord({ socketId: "a" })] },
    });
    (socket as unknown as FakeSocket).fire("database:presence-update", {
      workspaceId: "w",
      databaseId: "other",
      socketId: "a",
      fieldId: "f1",
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test("updateFocus emits only after the join ack", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    service.acquire();
    service.updateFocus({ rowId: "r1" });
    const fakeSocket = socket as unknown as FakeSocket;
    expect(
      fakeSocket.emits.filter((e) => e.name === "database:update-presence"),
    ).toHaveLength(0);
    fakeSocket.ackWith({ data: { presence: [] } });
    // The join ack re-broadcasts the queued focus once, then any explicit
    // updateFocus after the ack emits again.
    service.updateFocus({ rowId: "r2" });
    const updates = fakeSocket.emits.filter(
      (e) => e.name === "database:update-presence",
    );
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toMatchObject({
      workspaceId: "w",
      databaseId: "d",
      rowId: "r2",
    });
  });

  test("change events from a different database are ignored", () => {
    const socket = makeSocket();
    const onChange = vi.fn();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
      onChange,
    });
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({ data: { presence: [] } });
    (socket as unknown as FakeSocket).fire("database:change", {
      workspaceId: "w",
      databaseId: "other",
      kind: "cell_updated",
      actorUserId: "u1",
      committedAt: "2026-07-08T00:00:00.000Z",
      eventId: "event-2",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("refresh emits load-presence and replaces the snapshot", async () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      data: { presence: [makeRecord({ socketId: "old" })] },
    });
    const promise = service.refresh();
    (socket as unknown as FakeSocket).ackWith({
      data: { presence: [makeRecord({ socketId: "new" })] },
    });
    await promise;
    expect(service.listPresence()).toHaveLength(1);
    expect(service.listPresence()[0].socketId).toBe("new");
    const lateRefresh = service.refresh();
    service.dispose();
    (socket as unknown as FakeSocket).ackWith({
      data: { presence: [makeRecord({ socketId: "late" })] },
    });
    await lateRefresh;
    expect(service.listPresence()).toEqual([]);
  });

  test("release leaves the room and drops the snapshot", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({
      data: { presence: [makeRecord()] },
    });
    service.release();
    expect(service.listPresence()).toHaveLength(0);
  });

  test("joined clients heartbeat and stop after leaving", () => {
    vi.useFakeTimers();
    try {
      const socket = makeSocket();
      const service = new DatabasePresenceService({
        socket,
        workspaceId: "w",
        databaseId: "d",
      });
      service.acquire();
      (socket as unknown as FakeSocket).ackWith({ data: { presence: [] } });
      vi.advanceTimersByTime(30_000);
      expect(
        (socket as unknown as FakeSocket).emits.filter(
          (event) => event.name === "database:update-presence",
        ),
      ).toHaveLength(1);
      service.release();
      vi.advanceTimersByTime(30_000);
      expect(
        (socket as unknown as FakeSocket).emits.filter(
          (event) => event.name === "database:update-presence",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a remote join presence update adds the collaborator", () => {
    const socket = makeSocket();
    const service = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    service.acquire();
    (socket as unknown as FakeSocket).ackWith({ data: { presence: [] } });
    (socket as unknown as FakeSocket).fire("database:presence-update", {
      workspaceId: "w",
      databaseId: "d",
      socketId: "remote",
      userId: "user-remote",
      displayName: "Remote User",
      lastActiveAt: "2026-07-10T00:00:00.000Z",
    });
    expect(service.listPresence()).toEqual([
      expect.objectContaining({
        socketId: "remote",
        displayName: "Remote User",
      }),
    ]);
  });

  test("disposing one shared room consumer preserves the other and cleans up late joins", () => {
    const socket = makeSocket();
    const fake = socket as unknown as FakeSocket;
    const onChange = vi.fn();
    const first = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    const second = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
      onChange,
    });
    first.acquire();
    second.acquire();
    expect(fake.emits.filter((e) => e.name === "database:join")).toHaveLength(
      1,
    );
    fake.ackWith({ data: { presence: [makeRecord()] } });
    expect(first.listPresence()).toHaveLength(1);
    expect(second.listPresence()).toHaveLength(1);
    first.dispose();
    expect(first.listPresence()).toEqual([]);
    expect(fake.emits.filter((e) => e.name === "database:leave")).toHaveLength(
      0,
    );
    fake.fire("database:change", {
      workspaceId: "w",
      databaseId: "d",
      kind: "view_updated",
      actorUserId: "u1",
      committedAt: "2026-07-08T00:00:00.000Z",
      eventId: "shared-room-event",
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(fake.emits.filter((e) => e.name === "database:leave")).toHaveLength(
      1,
    );
    expect(fake.handlers.get("database:presence-update")).toBeUndefined();
    expect(fake.handlers.get("database:change")).toBeUndefined();
    const pending = new DatabasePresenceService({
      socket,
      workspaceId: "w",
      databaseId: "d",
    });
    pending.acquire();
    pending.dispose();
    fake.ackWith({ data: { presence: [makeRecord({ socketId: "late" })] } });
    expect(pending.listPresence()).toEqual([]);
    expect(fake.emits.filter((e) => e.name === "database:leave")).toHaveLength(
      2,
    );
    expect(fake.handlers.get("database:change")).toBeUndefined();
  });
});

describe("deriveInteractionMode", () => {
  test("null focus returns viewing", () => {
    expect(deriveInteractionMode(null)).toBe("viewing");
  });
  test("dragging beats fieldId/rowId", () => {
    expect(
      deriveInteractionMode({ dragging: true, fieldId: "f", rowId: "r" }),
    ).toBe("dragging");
  });
  test("fieldId maps to editing", () => {
    expect(deriveInteractionMode({ fieldId: "f" })).toBe("editing");
  });
  test("rowId maps to selecting", () => {
    expect(deriveInteractionMode({ rowId: "r" })).toBe("selecting");
  });
  test("empty focus returns viewing", () => {
    expect(deriveInteractionMode({})).toBe("viewing");
  });
});

describe("changeEventAffectsLocalTarget", () => {
  const baseEvent = {
    workspaceId: "w",
    databaseId: "d",
    kind: "cell_updated",
    actorUserId: "u1",
    committedAt: "2026-07-08T00:00:00.000Z",
    eventId: "event-base",
  };

  test("event without a target revalidates everything", () => {
    expect(
      changeEventAffectsLocalTarget({ ...baseEvent }, { rowId: "r1" }),
    ).toBe(true);
  });

  test("rowId match revalidates the focused row", () => {
    expect(
      changeEventAffectsLocalTarget(
        { ...baseEvent, target: { rowId: "r1" } },
        { rowId: "r1" },
      ),
    ).toBe(true);
  });

  test("rowId mismatch does not revalidate", () => {
    expect(
      changeEventAffectsLocalTarget(
        { ...baseEvent, target: { rowId: "r1" } },
        { rowId: "r2" },
      ),
    ).toBe(false);
  });

  test("fieldId match revalidates the focused field", () => {
    expect(
      changeEventAffectsLocalTarget(
        { ...baseEvent, target: { rowId: "r1", fieldId: "f1" } },
        { fieldId: "f1" },
      ),
    ).toBe(true);
  });
});
