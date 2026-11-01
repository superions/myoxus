// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { DatabaseTaskScope } from "@myoxus/graphql";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspace: { id: "workspace-a", flavour: "cloud" },
  account: { value: { id: "actor-a" } },
  serverId: "server-a",
  gql: vi.fn(),
  socket: {
    id: "task-test",
    connected: true,
    emit: vi.fn(),
    emitWithAck: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
  statusChanged: null as null | ((status: string) => void),
}));
vi.mock("@myoxus/storage/cloud", async (original) => {
  const actual = await original<typeof import("@myoxus/storage/cloud")>();
  return {
    ...actual,
    SocketConnection: class {
      status = "connected";
      maybeConnection = { socket: state.socket };
      onStatusChanged(callback: (status: string) => void) {
        state.statusChanged = callback;
        return () => {};
      }
      connect() {}
      disconnect() {}
    },
  };
});
vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class WorkspaceService {},
}));
vi.mock("@myoxus/core/modules/server/services/workspace-server", () => ({
  WorkspaceServerService: class WorkspaceServerService {},
}));
vi.mock("@myoxus/infra", () => ({
  useLiveData: (source: { value: unknown } | undefined) => source?.value,
  useService: (service: { name: string }) =>
    service.name === "WorkspaceService"
      ? { workspace: state.workspace }
      : {
          server$: {
            value: {
              id: state.serverId,
              baseUrl: "https://example.test",
              account$: state.account,
              config$: { value: { type: "Standalone" } },
              gql: state.gql,
            },
          },
        },
}));
import {
  useWorkspaceTasks,
  useTaskDestinations,
  useTaskIdentity,
} from "./use-workspace-tasks";
import { useTaskFreshness } from "./use-task-freshness";

function wrapper({ children }: PropsWithChildren) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}
// Each mounted hook owns native visibility/room listeners and a separate cache.
// Dispose them between cases before the next test dispatches browser events.
afterEach(cleanup);

const input = { scope: DatabaseTaskScope.Mine, timeZone: "Europe/Berlin" };
const response = (title: string) => ({
  workspace: {
    databaseTasks: {
      rows: [{ title }],
      totalCount: 1,
      projectCount: 1,
      nextCursor: null,
    },
  },
});

describe("workspace Tasks query identity", () => {
  beforeEach(() => {
    state.workspace = { id: "workspace-a", flavour: "cloud" };
    state.account.value = { id: "actor-a" };
    state.serverId = "server-a";
    state.gql.mockReset();
    state.socket.id += "-next";
    state.socket.connected = true;
    state.socket.on.mockReset();
    state.socket.off.mockReset();
    state.socket.emitWithAck
      .mockReset()
      .mockImplementation(() => new Promise(() => {}));
  });

  it("requires room ACK, coalesces scoped hints and recovers visible/disconnected reads", async () => {
    let acknowledge!: (value: unknown) => void;
    state.socket.emitWithAck.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    state.gql.mockResolvedValue(response("Before collaborator edit"));
    const invalidated = vi.fn();
    const { result, unmount } = renderHook(
      () => useWorkspaceTasks(input, 4, undefined, invalidated),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.page?.rows[0].title).toBe(
        "Before collaborator edit",
      ),
    );
    expect(result.current.live).toBe(false);
    const listener = state.socket.on.mock.calls.find(
      ([event]) => event === "database:tasks-changed",
    )![1];
    await act(async () => {
      acknowledge({ data: { clientId: state.socket.id, success: true } });
    });
    await waitFor(() => expect(result.current.live).toBe(true));
    await waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));
    state.gql.mockClear();
    invalidated.mockClear();
    await act(async () => {
      listener({ workspaceId: "other-workspace" });
    });
    expect(state.gql).not.toHaveBeenCalled();
    state.gql.mockResolvedValue(response("After collaborator edit"));
    act(() => {
      listener({ workspaceId: "workspace-a" });
      listener({ workspaceId: "workspace-a" });
    });
    await waitFor(() =>
      expect(result.current.page?.rows[0].title).toBe(
        "After collaborator edit",
      ),
    );
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(state.gql).toHaveBeenCalledTimes(1);
    state.gql.mockRejectedValueOnce(new Error("Canonical refresh failed"));
    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow(
        "Canonical refresh failed",
      );
    });
    act(() => {
      state.socket.connected = false;
      state.statusChanged?.("disconnected");
    });
    expect(result.current.live).toBe(false);
    state.gql.mockClear();
    act(() => {
      listener({ workspaceId: "workspace-a" });
    });
    expect(state.gql).not.toHaveBeenCalled();
    state.socket.connected = true;
    state.socket.id = "reconnected";
    act(() => state.statusChanged?.("connected"));
    await act(async () =>
      acknowledge({ data: { clientId: "reconnected", success: true } }),
    );
    await waitFor(() => expect(result.current.live).toBe(true));
    await waitFor(() => expect(state.gql).toHaveBeenCalledTimes(1));
    state.gql.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () =>
      acknowledge({ data: { clientId: "reconnected", success: true } }),
    );
    await waitFor(() => expect(state.gql).toHaveBeenCalledTimes(1));
    state.gql.mockClear();
    unmount();
    act(() => listener({ workspaceId: "workspace-a" }));
    expect(state.gql).not.toHaveBeenCalled();
  });

  it("withdraws Live offline with an unchanged socket and reconciles only after online ACK and canonical success", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    state.socket.emitWithAck.mockResolvedValue({
      data: { clientId: state.socket.id, success: true },
    });
    const refresh = vi.fn(async () => {});
    const { result, unmount } = renderHook(
      () => useTaskFreshness(useTaskIdentity(), refresh),
      { wrapper },
    );
    try {
      await waitFor(() => expect(result.current.live).toBe(true));
      let rejectOld!: (error: Error) => void;
      refresh.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOld = reject;
          }),
      );
      const hint = state.socket.on.mock.calls.find(
        ([event]) => event === "database:tasks-changed",
      )![1];
      act(() => hint({ workspaceId: "workspace-a" }));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      online.mockReturnValue(false);
      act(() => window.dispatchEvent(new Event("offline")));
      expect(state.socket.connected).toBe(true);
      expect(result.current.live).toBe(false);
      const joins = state.socket.emitWithAck.mock.calls.length;
      act(() => state.statusChanged?.("connected"));
      expect(state.socket.emitWithAck).toHaveBeenCalledTimes(joins);
      await act(async () =>
        rejectOld(new Error("Offline canonical read failed")),
      );
      expect(result.current.live).toBe(false);
      let acknowledge!: (value: unknown) => void;
      state.socket.emitWithAck.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      );
      let completeCurrent!: () => void;
      refresh.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeCurrent = resolve;
          }),
      );
      online.mockReturnValue(true);
      act(() => window.dispatchEvent(new Event("online")));
      expect(state.socket.emitWithAck).toHaveBeenCalledTimes(joins + 1);
      expect(result.current.live).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(2);
      // An ACK arriving after another offline transition cannot revive its lease.
      online.mockReturnValue(false);
      act(() => window.dispatchEvent(new Event("offline")));
      await act(async () =>
        acknowledge({ data: { clientId: state.socket.id, success: true } }),
      );
      expect(result.current.live).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(2);
      state.socket.emitWithAck.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      );
      online.mockReturnValue(true);
      act(() => window.dispatchEvent(new Event("online")));
      expect(state.socket.emitWithAck).toHaveBeenCalledTimes(joins + 2);
      await act(async () =>
        acknowledge({ data: { clientId: state.socket.id, success: true } }),
      );
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
      expect(result.current.live).toBe(false);
      await act(async () => completeCurrent());
      await waitFor(() => expect(result.current.live).toBe(true));
      unmount();
      const finalJoins = state.socket.emitWithAck.mock.calls.length;
      act(() => window.dispatchEvent(new Event("online")));
      expect(state.socket.emitWithAck).toHaveBeenCalledTimes(finalJoins);
    } finally {
      unmount();
      online.mockRestore();
    }
  });

  it("fences prior Mine data and late responses when the actor changes", async () => {
    let resolveOld!: (value: unknown) => void;
    state.gql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    state.gql.mockResolvedValueOnce(response("Actor B Task"));
    const { result, rerender } = renderHook(() => useWorkspaceTasks(input, 4), {
      wrapper,
    });
    await waitFor(() => expect(state.gql).toHaveBeenCalledTimes(1));
    state.account.value = { id: "actor-b" };
    rerender();
    expect(result.current.page).toBeUndefined();
    await waitFor(() =>
      expect(result.current.page?.rows[0].title).toBe("Actor B Task"),
    );
    await act(async () => {
      resolveOld(response("Actor A private Task"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.page?.rows[0].title).toBe("Actor B Task"),
    );
    expect(state.gql).toHaveBeenCalledTimes(2);
  });

  it("clears previous workspace and query pages instead of showing stale membership", async () => {
    state.gql.mockResolvedValueOnce(response("Workspace A Task"));
    let resolveNew!: (value: unknown) => void;
    state.gql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ scope }) => useWorkspaceTasks({ ...input, scope }, 4),
      { initialProps: { scope: DatabaseTaskScope.Mine }, wrapper },
    );
    await waitFor(() =>
      expect(result.current.page?.rows[0].title).toBe("Workspace A Task"),
    );
    state.workspace = { id: "workspace-b", flavour: "cloud" };
    rerender({ scope: DatabaseTaskScope.All });
    expect(result.current.page).toBeUndefined();
    await waitFor(() => expect(state.gql).toHaveBeenCalledTimes(2));
    expect(state.gql.mock.calls[1][0].variables.workspaceId).toBe(
      "workspace-b",
    );
    resolveNew(response("Workspace B Task"));
    await waitFor(() =>
      expect(result.current.page?.rows[0].title).toBe("Workspace B Task"),
    );
  });
});

it("removes cached destination choices on terminal authorization failure", async () => {
  state.workspace = { id: "revoked-destinations", flavour: "cloud" };
  state.gql.mockReset().mockResolvedValue({
    workspace: {
      databaseTaskDestinations: {
        defaultDestination: {
          databaseId: "default",
          title: "Tasks",
          editRevision: 1,
          managedSchema: { readiness: "Ready" },
        },
        projects: [],
        nextCursor: null,
        unavailableProjects: [],
        coverageComplete: true,
      },
    },
  });
  const { result } = renderHook(() => useTaskDestinations(), { wrapper });
  await waitFor(() => expect(result.current.readyDestinations).toHaveLength(1));
  state.gql.mockRejectedValue(new Error("MIX_DATABASE_FORBIDDEN"));
  await act(async () => {
    try {
      await result.current.mutate();
    } catch {
      /* Assert the terminal destination failure below. */
    }
  });
  await waitFor(() => expect(result.current.destinationError).toBe(true));
  expect(result.current.readyDestinations).toEqual([]);
  expect(result.current.defaultDestination).toBeNull();
});
