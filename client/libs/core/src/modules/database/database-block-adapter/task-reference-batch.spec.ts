// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
  type DatabaseTaskReferenceFragment,
} from "@myoxus/graphql";
import { waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { TaskReferenceTarget } from "../tasks/task-reference-insertion";
const freshness = vi.hoisted(() => ({
  leases: [] as {
    refresh: () => Promise<unknown>;
    live: (value: boolean) => void;
    stop: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("../tasks/use-task-freshness", () => ({
  subscribeTaskFreshness: (
    _owner: unknown,
    refresh: () => Promise<unknown>,
    live: (value: boolean) => void,
  ) => {
    const stop = vi.fn();
    freshness.leases.push({ refresh, live, stop });
    return stop;
  },
}));
import { TaskReferenceBatch } from "./task-reference-batch";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const databaseId = "00000000-0000-4000-8000-000000000002";
const target = (index: number): TaskReferenceTarget => ({
  workspaceId,
  databaseId,
  rowId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
});
function projection(
  target: TaskReferenceTarget,
  title = "Canonical Task",
): DatabaseTaskReferenceFragment {
  return {
    ...target,
    state: DatabaseTaskReferenceState.Available,
    task: {
      ...target,
      projectTitle: "Project",
      descriptionPreview: null,
      title,
      editRevision: 1,
      updatedAt: "2026-10-15T00:00:00Z",
      deletedAt: null,
      status: null,
      assignees: [],
      due: null,
      priority: null,
      canEdit: true,
      hasAssignees: false,
      hasDue: false,
      hasPriority: false,
      isSubtask: null,
      hasDependencies: null,
    },
  };
}
function fixture(gql = vi.fn()) {
  const server = {
    gql,
    id: "server",
    baseUrl: "https://myoxus.test",
    account$: { value: { id: "actor-a" } },
  };
  const owner = {
    server,
    account: { id: "actor-a" },
    workspace: { id: workspaceId },
    availability: {
      status: "available",
      reason: "server-backed",
      serverWorkspaceId: workspaceId,
    },
    identity: JSON.stringify([
      server.id,
      server.baseUrl,
      "actor-a",
      workspaceId,
    ]),
  } as unknown as ReturnType<typeof useTaskIdentity>;
  return { server, owner, gql, batch: new TaskReferenceBatch() };
}
beforeEach(() => {
  freshness.leases.length = 0;
});

test("deduplicates document targets, reads at most 500 per request and releases the shared hint lease", async () => {
  const f = fixture(
    vi.fn(
      async ({
        variables,
      }: {
        variables: { targets: TaskReferenceTarget[] };
        query: unknown;
      }) => ({
        workspace: {
          databaseTaskReferences: variables.targets.map(
            (target: TaskReferenceTarget) => projection(target),
          ),
        },
      }),
    ),
  );
  const dispose = Array.from({ length: 501 }, (_, index) =>
    f.batch.attach(f.owner, target(index), vi.fn()),
  );
  dispose.push(f.batch.attach(f.owner, target(0), vi.fn()));
  await waitFor(() =>
    expect(f.batch.snapshot(f.owner, target(500)).status).toBe("ready"),
  );
  expect(
    f.gql.mock.calls.map(([request]) => request.variables.targets.length),
  ).toEqual([500, 1]);
  expect(
    f.gql.mock.calls.every(
      ([request]) => request.query === databaseTaskReferencesQuery,
    ),
  ).toBe(true);
  expect(freshness.leases).toHaveLength(1);
  dispose.forEach((release) => release());
  expect(freshness.leases[0].stop).toHaveBeenCalledOnce();
  expect(f.batch.snapshot(f.owner, target(0)).status).toBe("loading");
});

test("actor changes hide old titles and fence delayed completions", async () => {
  let resolveOld!: (value: unknown) => void;
  const f = fixture(
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        workspace: {
          databaseTaskReferences: [projection(target(0), "New actor Task")],
        },
      }),
  );
  const releaseOld = f.batch.attach(f.owner, target(0), vi.fn());
  await waitFor(() => expect(f.gql).toHaveBeenCalledOnce());
  f.server.account$.value.id = "actor-b";
  expect(f.batch.snapshot(f.owner, target(0))).toEqual({
    status: "unavailable",
  });
  const newOwner = {
    ...f.owner,
    identity: JSON.stringify([
      f.server.id,
      f.server.baseUrl,
      "actor-b",
      workspaceId,
    ]),
  };
  const releaseNew = f.batch.attach(newOwner, target(0), vi.fn());
  await waitFor(() =>
    expect(f.batch.snapshot(newOwner, target(0))).toEqual({
      status: "ready",
      reference: projection(target(0), "New actor Task"),
    }),
  );
  resolveOld({
    workspace: {
      databaseTaskReferences: [projection(target(0), "Private old Task")],
    },
  });
  await Promise.resolve();
  expect(f.batch.snapshot(newOwner, target(0))).toEqual({
    status: "ready",
    reference: projection(target(0), "New actor Task"),
  });
  releaseOld();
  releaseNew();
});

test("same-actor refresh preserves the ready editor boundary until the new projection arrives", async () => {
  let finish!: (value: unknown) => void;
  const current = {
    workspace: { databaseTaskReferences: [projection(target(1))] },
  };
  const f = fixture(
    vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
  );
  const release = f.batch.attach(f.owner, target(1), vi.fn());
  await waitFor(() =>
    expect(f.batch.snapshot(f.owner, target(1)).status).toBe("ready"),
  );
  const before = f.batch.snapshot(f.owner, target(1));
  const refresh = f.batch.refresh();
  expect(f.batch.snapshot(f.owner, target(1))).toBe(before);
  finish(current);
  await refresh;
  release();
});

test("disconnect aborts a hanging read and reconnect can publish fresh summary before the old response returns", async () => {
  let resolveOld!: (value: unknown) => void;
  const f = fixture(
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        workspace: {
          databaseTaskReferences: [projection(target(1), "Reconnected Task")],
        },
      }),
  );
  const release = f.batch.attach(f.owner, target(1), vi.fn());
  await waitFor(() => expect(f.gql).toHaveBeenCalledOnce());
  const signal = f.gql.mock.calls[0][0].context.signal as AbortSignal;
  freshness.leases[0].live(false);
  expect(signal.aborted).toBe(true);
  expect(f.batch.snapshot(f.owner, target(1))).toEqual({ status: "offline" });
  freshness.leases[0].live(true);
  await freshness.leases[0].refresh();
  expect(f.batch.snapshot(f.owner, target(1))).toEqual({
    status: "ready",
    reference: projection(target(1), "Reconnected Task"),
  });
  resolveOld({
    workspace: {
      databaseTaskReferences: [projection(target(1), "Stale Task")],
    },
  });
  await Promise.resolve();
  expect(f.batch.snapshot(f.owner, target(1))).toEqual({
    status: "ready",
    reference: projection(target(1), "Reconnected Task"),
  });
  release();
});

test("a mismatched echoed target becomes neutral unavailable instead of remaining loading", async () => {
  const f = fixture(
    vi.fn().mockResolvedValue({
      workspace: {
        databaseTaskReferences: [projection(target(99), "Foreign echo")],
      },
    }),
  );
  const release = f.batch.attach(f.owner, target(0), vi.fn());
  await waitFor(() =>
    expect(f.batch.snapshot(f.owner, target(0))).toEqual({
      status: "unavailable",
    }),
  );
  release();
});

test("browser offline immediately clears every private projection and online reconciles despite an unchanged socket", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  let resolveOld!: (value: unknown) => void;
  const references = (title: string) => ({
    workspace: {
      databaseTaskReferences: [
        projection(target(0), title),
        projection(target(1), title),
      ],
    },
  });
  const f = fixture(
    vi
      .fn()
      .mockResolvedValueOnce(references("Private cached Task"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(references("Reauthorized Task")),
  );
  const dispose = [
    f.batch.attach(f.owner, target(0), vi.fn()),
    f.batch.attach(f.owner, target(1), vi.fn()),
  ];
  try {
    await waitFor(() =>
      expect(f.batch.snapshot(f.owner, target(1)).status).toBe("ready"),
    );
    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    for (const id of [0, 1])
      expect(f.batch.snapshot(f.owner, target(id))).toEqual({
        status: "offline",
      });
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(f.gql).toHaveBeenCalledTimes(2));
    const signal = f.gql.mock.calls[1][0].context.signal as AbortSignal;
    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(signal.aborted).toBe(true);
    for (const id of [0, 1])
      expect(f.batch.snapshot(f.owner, target(id))).toEqual({
        status: "offline",
      });
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await waitFor(() =>
      expect(f.batch.snapshot(f.owner, target(1))).toEqual({
        status: "ready",
        reference: projection(target(1), "Reauthorized Task"),
      }),
    );
    resolveOld(references("Stale private Task"));
    await Promise.resolve();
    for (const id of [0, 1])
      expect(f.batch.snapshot(f.owner, target(id))).toEqual({
        status: "ready",
        reference: projection(target(id), "Reauthorized Task"),
      });
    expect(f.gql).toHaveBeenCalledTimes(3);
    dispose.forEach((release) => release());
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(f.gql).toHaveBeenCalledTimes(3);
    expect(freshness.leases[0].stop).toHaveBeenCalledOnce();
  } finally {
    dispose.forEach((release) => release());
    online.mockRestore();
  }
});
