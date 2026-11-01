// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: focused unit tests for the React hook wrapper.
//
// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Socket } from "socket.io-client";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { DatabasePresenceRecord } from "./service";
import { useDatabasePresence } from "./use-database-presence";

class FakeSocket {
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

  emit(
    name: string,
    payload: unknown,
    ack?: (response: unknown) => void,
  ): void {
    this.emits.push({ name, payload, hasAck: typeof ack === "function" });
    if (typeof ack === "function") this.nextAck = ack;
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
    for (const handler of this.handlers.get(name) ?? []) handler(payload);
  }

  ackWith(response: unknown): void {
    const ack = this.nextAck;
    this.nextAck = null;
    if (ack) ack(response);
  }
}

function makeSocket(): { socket: Socket; fake: FakeSocket } {
  const fake = new FakeSocket();
  return { socket: fake as unknown as Socket, fake };
}

function makeRecord(
  overrides: Partial<DatabasePresenceRecord> = {},
): DatabasePresenceRecord {
  return {
    socketId: overrides.socketId ?? "s1",
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

afterEach(() => {
  cleanup();
});

describe("useDatabasePresence", () => {
  test("acquires the service on mount and releases on unmount", async () => {
    const { socket, fake } = makeSocket();
    const { unmount } = renderHook(() =>
      useDatabasePresence({ socket, workspaceId: "w", databaseId: "d" }),
    );
    await waitFor(() =>
      expect(fake.emits.filter((e) => e.name === "database:join")).toHaveLength(
        1,
      ),
    );
    await act(async () => {
      fake.ackWith({ data: { presence: [] } });
    });
    unmount();
    await waitFor(() =>
      expect(
        fake.emits.filter((e) => e.name === "database:leave"),
      ).toHaveLength(1),
    );
  });

  test("updates presence after the join ack", async () => {
    const { socket, fake } = makeSocket();
    const { result } = renderHook(() =>
      useDatabasePresence({ socket, workspaceId: "w", databaseId: "d" }),
    );
    await waitFor(() => expect(result.current.connected).toBe(false));
    await act(async () => {
      fake.ackWith({ data: { presence: [makeRecord({ socketId: "a" })] } });
    });
    await waitFor(() => expect(result.current.collaborators).toHaveLength(1));
    expect(result.current.connected).toBe(true);
  });

  test("indexes presence by rowId and fieldId", async () => {
    const { socket, fake } = makeSocket();
    const { result } = renderHook(() =>
      useDatabasePresence({ socket, workspaceId: "w", databaseId: "d" }),
    );
    await act(async () => {
      fake.ackWith({
        data: {
          presence: [
            makeRecord({ socketId: "a", rowId: "r1", fieldId: "f1" }),
            makeRecord({ socketId: "b", rowId: "r1" }),
            makeRecord({ socketId: "c", fieldId: "f2" }),
          ],
        },
      });
    });
    await waitFor(() =>
      expect(result.current.presenceByRowId.get("r1")).toHaveLength(2),
    );
    expect(result.current.presenceByFieldId.get("f1")).toHaveLength(1);
    expect(result.current.presenceByFieldId.get("f2")).toHaveLength(1);
    expect(result.current.draggingUserIds).toHaveLength(0);
  });

  test("updateFocus emits a database:update-presence payload", async () => {
    const { socket, fake } = makeSocket();
    const { result } = renderHook(() =>
      useDatabasePresence({ socket, workspaceId: "w", databaseId: "d" }),
    );
    await waitFor(() =>
      expect(fake.emits.filter((e) => e.name === "database:join")).toHaveLength(
        1,
      ),
    );
    await act(async () => {
      fake.ackWith({ data: { presence: [] } });
    });
    await waitFor(() => expect(result.current.connected).toBe(true));
    result.current.updateFocus({ rowId: "r1" });
    const update = fake.emits.find(
      (e) => e.name === "database:update-presence",
    );
    expect(update).toBeDefined();
    expect(update?.payload).toMatchObject({
      workspaceId: "w",
      databaseId: "d",
      rowId: "r1",
    });
  });

  test("publishLocal=false suppresses updateFocus emits", async () => {
    const { socket, fake } = makeSocket();
    const { result } = renderHook(() =>
      useDatabasePresence({
        socket,
        workspaceId: "w",
        databaseId: "d",
        publishLocal: false,
      }),
    );
    await waitFor(() =>
      expect(fake.emits.filter((e) => e.name === "database:join")).toHaveLength(
        1,
      ),
    );
    await act(async () => {
      fake.ackWith({ data: { presence: [] } });
    });
    result.current.updateFocus({ rowId: "r1" });
    expect(
      fake.emits.filter((e) => e.name === "database:update-presence"),
    ).toHaveLength(0);
  });

  test("forwards change events to the host", async () => {
    const { socket, fake } = makeSocket();
    const onChange = vi.fn();
    renderHook(() =>
      useDatabasePresence({
        socket,
        workspaceId: "w",
        databaseId: "d",
        onChange,
      }),
    );
    await waitFor(() =>
      expect(fake.emits.filter((e) => e.name === "database:join")).toHaveLength(
        1,
      ),
    );
    await act(async () => {
      fake.ackWith({ data: { presence: [] } });
    });
    fake.fire("database:change", {
      workspaceId: "w",
      databaseId: "d",
      kind: "cell_updated",
      actorUserId: "u1",
      committedAt: "2026-07-08T00:00:00.000Z",
      eventId: "event-1",
      target: { rowId: "r1", fieldId: "f1" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cell_updated" }),
    );
  });

  test("rerendering with a new socket triggers a fresh join", async () => {
    const a = makeSocket();
    const b = makeSocket();
    const { rerender } = renderHook(
      ({ target }: { target: Socket }) =>
        useDatabasePresence({
          socket: target,
          workspaceId: "w",
          databaseId: "d",
        }),
      { initialProps: { target: a.socket } },
    );
    await waitFor(() =>
      expect(
        a.fake.emits.filter((e) => e.name === "database:join"),
      ).toHaveLength(1),
    );
    await act(async () => {
      a.fake.ackWith({ data: { presence: [] } });
    });
    rerender({ target: b.socket });
    await waitFor(() =>
      expect(
        a.fake.emits.filter((e) => e.name === "database:leave"),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        b.fake.emits.filter((e) => e.name === "database:join"),
      ).toHaveLength(1),
    );
  });
});
