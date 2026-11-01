// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  databaseSchemaQuery,
  databaseRowQuery,
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
} from "@myoxus/graphql";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, expect, test, vi } from "vitest";
const owner = vi.hoisted(() => ({ gql: vi.fn(), replace: vi.fn() }));
vi.mock("@myoxus/core/modules/database/tasks/use-workspace-tasks", () => ({
  useTaskIdentity: () => ({
    identity: "actor/workspace",
    workspace: { id: "workspace" },
    availability: { status: "available" },
    server: { gql: owner.gql },
  }),
}));
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: () => ({ view: { replace: owner.replace } }),
}));
vi.mock("@myoxus/core/modules/database/tasks/use-task-freshness", () => ({
  useTaskFreshness: () => ({ live: false }),
}));
import { DatabaseTaskOwnerBoundary } from "./task-owner-boundary";

afterEach(cleanup);
function NativeContent() {
  const { mutate } = useSWRConfig();
  return (
    <button
      onClick={() =>
        void mutate(() => true, undefined, { throwOnError: false })
      }
    >
      Native content
    </button>
  );
}
function RouteHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/databases/source")}>Close row</button>
      <button onClick={() => navigate("/databases/source?rowId=original")}>
        Open row
      </button>
      <DatabaseTaskOwnerBoundary
        renderState={(state, retry) => <button onClick={retry}>{state}</button>}
      >
        <NativeContent />
      </DatabaseTaskOwnerBoundary>
    </>
  );
}
function mount(cache = new Map()) {
  return render(
    <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
      <MemoryRouter initialEntries={["/databases/source?rowId=original"]}>
        <Routes>
          <Route path="/databases/:databaseId" element={<RouteHarness />} />
        </Routes>
      </MemoryRouter>
    </SWRConfig>,
  );
}
function available(databaseId: string) {
  return {
    workspace: {
      databaseTaskReferences: [
        {
          workspaceId: "workspace",
          databaseId,
          rowId: "original",
          state: DatabaseTaskReferenceState.Available,
          task: { workspaceId: "workspace", databaseId, rowId: "original" },
        },
      ],
    },
  };
}

test("resolves a stored hint to the original Task's current owner before mounting native content", async () => {
  owner.replace.mockReset();
  owner.gql.mockReset().mockResolvedValue(available("target"));
  mount();
  await waitFor(() =>
    expect(owner.replace).toHaveBeenCalledWith(
      "/databases/target?rowId=original",
    ),
  );
  expect(screen.queryByText("Native content")).toBeNull();
  expect(
    owner.gql.mock.calls.filter(
      ([request]) => request.query === databaseSchemaQuery,
    ),
  ).toHaveLength(0);
  expect(owner.gql.mock.calls[0][0].query).toBe(databaseTaskReferencesQuery);
});

test("terminal denial removes warm native content instead of reading the old schema", async () => {
  owner.replace.mockReset();
  owner.gql.mockReset().mockResolvedValue(available("source"));
  mount();
  const content = await screen.findByRole("button", { name: "Native content" });
  owner.gql.mockRejectedValue(new Error("MIX_DATABASE_FORBIDDEN"));
  await userEvent.setup().click(content);
  expect(
    await screen.findByRole("button", { name: "forbidden" }),
  ).not.toBeNull();
  expect(screen.queryByText("Native content")).toBeNull();
  expect(
    owner.gql.mock.calls.filter(
      ([request]) => request.query === databaseSchemaQuery,
    ),
  ).toHaveLength(0);
  expect(owner.replace).not.toHaveBeenCalled();
});

test.each(["Generic"])(
  "preserves native non-Task %s Row links through an explicit authorized classification",
  async (profileKind) => {
    owner.replace.mockReset();
    owner.gql.mockReset().mockImplementation(async ({ query }) => {
      if (query === databaseTaskReferencesQuery)
        return {
          workspace: {
            databaseTaskReferences: [
              {
                workspaceId: "workspace",
                databaseId: "source",
                rowId: "original",
                state: DatabaseTaskReferenceState.Unavailable,
                task: null,
              },
            ],
          },
        };
      if (query === databaseSchemaQuery)
        return {
          workspace: {
            database: {
              database: { id: "source", workspaceId: "workspace", profileKind },
            },
          },
        };
      if (query === databaseRowQuery)
        return {
          workspace: {
            databaseRow: {
              redacted: false,
              row: { id: "original", databaseId: "source", rowKind: "phase" },
            },
          },
        };
      throw new Error("Unexpected operation");
    });
    mount();
    expect(
      await screen.findByRole("button", { name: "Native content" }),
    ).not.toBeNull();
    expect(owner.replace).not.toHaveBeenCalled();
  },
);

test("a reopened boundary waits for current authorization despite a warm owner result", async () => {
  const cache = new Map();
  owner.replace.mockReset();
  owner.gql.mockReset().mockResolvedValue(available("source"));
  mount(cache);
  await screen.findByRole("button", { name: "Native content" });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Close row" }));
  let reject!: (error: Error) => void;
  owner.gql.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Open row" }));
  expect(screen.queryByText("Native content")).toBeNull();
  await waitFor(() => expect(owner.gql.mock.calls.length).toBeGreaterThan(1));
  await act(async () => {
    reject(new Error("MIX_DATABASE_FORBIDDEN"));
  });
  expect(
    await screen.findByRole("button", { name: "forbidden" }),
  ).not.toBeNull();
  expect(screen.queryByText("Native content")).toBeNull();
});
