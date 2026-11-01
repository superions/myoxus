// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { GuardService } from "@myoxus/core/modules/permissions";
import { GuardStore } from "@myoxus/core/modules/permissions/stores/guard";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { GraphQLError } from "@myoxus/error";
import {
  workspaceOverviewSettingsQuery,
  updateWorkspaceOverviewMutation,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { Framework, LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceOverviewConfiguration } from "./configuration";

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useServices: () => fixture.services,
}));
vi.mock("@myoxus/i18n", async () =>
  (
    await import("../../../../modules/database/test-i18n-mock")
  ).createDatabaseTestI18nModule(),
);
const disposables: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposables.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

test("configuration preserves drafts through refresh and failed saves, and advances only confirmed revisions", async () => {
  const resource = (id: string) => ({
    workspaceId: "workspace",
    kind: WorkspaceContentResourceKindType.Document,
    id,
  });
  let current = {
    revision: 1,
    introduction: resource("Original Page"),
    folderIds: ["removed-folder"] as string[] | null,
    folders: [
      { folderId: "other-scope", introduction: resource("Other Page") },
    ],
  };
  let failRead = false;
  const writes: Array<{
    expectedRevision: number;
    introduction?: unknown;
    folderIds?: unknown;
  }> = [];
  const workspaceService = {
    workspace: { id: "workspace", flavour: "myoxus-cloud", openOptions: {} },
  } as unknown as WorkspaceService;
  const framework = new Framework();
  framework.service(WorkspaceService, workspaceService);
  framework.store(GuardStore, {
    getDocPermissions: async () => ({ Doc_Read: true }),
  } as unknown as GuardStore);
  framework.service(GuardService, [GuardStore, WorkspaceService]);
  framework.service(WorkspaceDialogService);
  const provider = framework.provider();
  disposables.push(() => provider.dispose());
  const dialogs = provider.get(WorkspaceDialogService);
  const select = (ids?: string[]) => {
    const dialog = dialogs.dialogs$.value.at(-1);
    if (!dialog || dialog.type !== "doc-selector")
      throw new Error("Document picker was not opened");
    act(() => dialogs.close(dialog.id, ids));
  };
  const gql = vi.fn(
    async ({
      query,
      variables,
    }: {
      query: { id: string };
      variables: { input?: { overview: (typeof writes)[number] } };
    }) => {
      if (query.id === workspaceOverviewSettingsQuery.id) {
        if (failRead) throw new Error("Reload interrupted");
        return {
          workspace: {
            id: "workspace",
            overviewSettings: structuredClone(current),
          },
        };
      }
      if (query.id !== updateWorkspaceOverviewMutation.id || !variables.input)
        throw new Error("Unexpected operation");
      const patch = variables.input.overview;
      writes.push(structuredClone(patch));
      if (writes.length === 1) throw new Error("Connection interrupted");
      if (patch.expectedRevision !== current.revision)
        throw new GraphQLError("Stale settings", {
          extensions: { name: "WORKSPACE_OVERVIEW_REVISION_CONFLICT" },
        });
      current = {
        ...current,
        revision: current.revision + 1,
        introduction: resource((patch.introduction as { id: string }).id),
      };
      return {
        updateWorkspace: {
          id: "workspace",
          overviewSettings: structuredClone(current),
        },
      };
    },
  );
  const server = {
    id: "server",
    baseUrl: "http://workspace.test",
    account$: new LiveData({ id: "owner" }),
    gql,
  };
  fixture.services = {
    workspaceService,
    workspaceServerService: { server$: new LiveData(server) },
    workspaceDialogService: dialogs,
    organizeService: {
      folderTree: { rootFolder: { sortedChildren$: new LiveData([]) } },
    },
    docDisplayMetaService: { title$: (id: string) => new LiveData(id) },
    guardService: provider.get(GuardService),
  };
  const onSaved = vi.fn();
  let refresh: ReturnType<typeof useSWRConfig>["mutate"];
  function Journey() {
    refresh = useSWRConfig().mutate;
    const [open, setOpen] = useState(false);
    const [session, setSession] = useState(0);
    const trigger = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button
          ref={trigger}
          onClick={() => {
            setSession((value) => value + 1);
            setOpen(true);
          }}
        >
          Configure
        </button>
        <WorkspaceOverviewConfiguration
          key={session}
          open={open}
          scopeTitle="Workspace"
          onOpenChange={setOpen}
          onSaved={onSaved}
          returnFocusRef={trigger}
        />
      </>
    );
  }
  render(
    <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
      <MyoxusUIProvider>
        <Journey />
      </MyoxusUIProvider>
    </SWRConfig>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Configure" }));
  await screen.findByText("Original Page");
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(screen.queryByText("Unavailable folder")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Clear introduction" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Configure" }),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Configure" }));
  await screen.findByText("Original Page");
  fireEvent.click(screen.getByRole("button", { name: "Choose document" }));
  expect(screen.queryByText("Original Page")).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);
  select();
  expect(screen.queryByText("Original Page")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose document" }));
  select(["Draft Page"]);
  await screen.findByText("Draft Page");
  current = {
    ...current,
    revision: 2,
    introduction: resource("Concurrent Page"),
  };
  await act(async () => {
    await refresh!(
      [
        workspaceOverviewSettingsQuery.id,
        server.id,
        server.baseUrl,
        "owner",
        "workspace",
      ],
      {
        workspace: {
          id: "workspace",
          overviewSettings: structuredClone(current),
        },
      },
      { revalidate: false },
    );
  });
  expect(screen.queryByText("Draft Page")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(
    "The settings could not be saved. Your draft is preserved; try again.",
  );
  expect(screen.queryByText("Draft Page")).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(
    "These settings changed elsewhere. Your draft is preserved. Reloading discards it and loads the current settings.",
  );
  expect(screen.queryByText("Draft Page")).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);
  failRead = true;
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await screen.findByText("The overview could not be loaded.");
  expect(screen.queryByText("Draft Page")).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);
  failRead = false;
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await screen.findByText("Concurrent Page");
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Choose document" }));
  select(["Draft Page"]);
  await screen.findByText("Draft Page");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Configure" }));
  await screen.findByText("Draft Page");
  fireEvent.click(screen.getByRole("button", { name: "Choose document" }));
  select(["Next Page"]);
  await screen.findByText("Next Page");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  expect(writes.map((patch) => patch.expectedRevision)).toEqual([1, 1, 2, 3]);
  expect(writes.every((patch) => !Object.hasOwn(patch, "folderIds"))).toBe(
    true,
  );
});
