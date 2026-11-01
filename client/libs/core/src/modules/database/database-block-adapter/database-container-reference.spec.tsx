// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { databaseSummaryQuery, DatabaseSystemRole } from "@myoxus/graphql";
import type { FrameworkProvider } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ owner: undefined as unknown }));
vi.mock("../tasks/use-workspace-tasks", () => ({
  useTaskIdentity: () => fixture.owner,
}));
vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});
import { DatabaseContainerReference } from "./database-container-reference";

afterEach(cleanup);

function setup(failed = false, systemRole: DatabaseSystemRole | null = null) {
  const gql = vi.fn().mockResolvedValue({
    workspace: {
      databaseSummary: {
        id: "container",
        systemRole,
        workspaceId: "workspace",
        title: "Authorized Workspace Tasks",
        deletedAt: null,
      },
    },
  });
  if (failed) gql.mockRejectedValue(new Error("Permission revoked"));
  const account = { id: "actor" };
  fixture.owner = {
    workspace: { id: "workspace" },
    account,
    server: {
      id: "server",
      baseUrl: "https://myoxus.test",
      account$: { value: account },
      gql,
    },
    identity: "server/actor/workspace",
    availability: { status: "available" },
  };
  const open = vi.fn();
  const framework = {
    get(token: unknown) {
      expect(token).toBe(WorkbenchService);
      return { workbench: { open } };
    },
  } as unknown as FrameworkProvider;
  const cache = new Map();
  const tree = () => (
    <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
      <MyoxusUIProvider>
        <DatabaseContainerReference
          framework={framework}
          workspaceId="workspace"
          databaseId="container"
        />
      </MyoxusUIProvider>
    </SWRConfig>
  );
  const view = render(tree());
  return { gql, open, tree, view };
}

test("compact native container opens the authorized object using metadata only", async () => {
  const { gql, open } = setup();
  await userEvent.click(
    await screen.findByRole("button", { name: "Authorized Workspace Tasks" }),
  );
  expect(gql).toHaveBeenCalledWith({
    query: databaseSummaryQuery,
    variables: { workspaceId: "workspace", databaseId: "container" },
  });
  expect(gql).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith("/databases/container", { at: "active" });
  expect(screen.queryByTestId("database-view-host-embed")).toBeNull();
});

test("losing the actual owner hides prior private metadata and disables native opening", async () => {
  const { open, tree, view } = setup();
  await screen.findByRole("button", { name: "Authorized Workspace Tasks" });
  fixture.owner = {
    workspace: { id: "workspace" },
    account: null,
    server: null,
    identity: null,
    availability: { status: "available" },
  };
  view.rerender(tree());
  expect(screen.queryByText("Authorized Workspace Tasks")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(open).not.toHaveBeenCalled();
});
