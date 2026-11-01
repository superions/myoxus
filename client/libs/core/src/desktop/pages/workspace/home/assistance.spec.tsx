// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import {
  AssistanceMode,
  AssistanceSource,
  workspaceSetupAssistanceQuery,
} from "@myoxus/graphql";
import {
  Framework,
  FrameworkRoot,
  LiveData,
  MemoryMemento,
} from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  AuthService,
  ServerService,
  UserPreferencesService,
  type Server,
} from "@myoxus/core/modules/server";
import { PreferenceStoreStub } from "@myoxus/core/modules/server/services/user-preferences.test-fixtures";
import { UserPreferencesStore } from "@myoxus/core/modules/server/stores/user-preferences";
import { localWorkspaceAssistanceKey } from "@myoxus/core/modules/workspace/metadata";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceHomeAssistance } from "./assistance";
vi.mock("@myoxus/i18n", async () =>
  (
    await import("@myoxus/core/modules/database/test-i18n-mock")
  ).createDatabaseTestI18nModule(),
);
afterEach(cleanup);

async function fixture() {
  const store = new PreferenceStoreStub();
  const accounts = new LiveData<{ id: string } | null>(null);
  const framework = new Framework();
  framework
    .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
    .service(WorkbenchService, {
      workbench: { openDoc: vi.fn() },
    } as unknown as WorkbenchService)
    .service(AuthService, {
      session: { account$: accounts },
    } as unknown as AuthService)
    .service(ServerService, {
      server: { id: "server-a" },
    } as unknown as ServerService)
    .service(UserPreferencesService, [
      UserPreferencesStore,
      AuthService,
      ServerService,
    ]);
  const preferences = framework.provider().get(UserPreferencesService);
  accounts.value = { id: "actor-a" };
  await vi.waitFor(() =>
    expect(preferences.confirmedPreferences$.value).toBeDefined(),
  );
  const server = {
    id: "server-a",
    account$: accounts,
    gql: vi.fn(
      async ({
        query,
        variables,
      }: {
        query: unknown;
        variables: { workspaceId: string };
      }) => {
        if (query !== workspaceSetupAssistanceQuery)
          throw new Error("Unexpected Home assistance operation");
        return {
          currentUser: { id: accounts.value?.id },
          workspace: {
            id: variables.workspaceId,
            workspaceSetupAssistance: null,
          },
        };
      },
    ),
    scope: { get: () => preferences },
  } as unknown as Server;
  const props = {
    server,
    workspaceId: "workspace-a",
    local: false,
    state: new MemoryMemento(),
    onNewTask: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenLibrary: vi.fn(),
  };
  return { store, preferences, props, provider: framework.provider() };
}

test("confirmed Guided links invoke the existing native entries only when the person chooses them", async () => {
  const { store, preferences, props, provider } = await fixture();
  try {
    store.assistance = {
      mode: AssistanceMode.Guided,
      source: AssistanceSource.Workspace,
      userDefaultExplicit: true,
      interactiveMode: AssistanceMode.Guided,
    };
    render(
      <FrameworkRoot framework={provider}>
        <MyoxusUIProvider>
          <WorkspaceHomeAssistance {...props} />
        </MyoxusUIProvider>
      </FrameworkRoot>,
    );
    await screen.findByRole("button", { name: "Capture from a note" });
    expect(props.onNewTask).not.toHaveBeenCalled();
    expect(props.onOpenNotes).not.toHaveBeenCalled();
    expect(props.onOpenLibrary).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Capture from a note" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(props.onNewTask).toHaveBeenCalledOnce();
    expect(props.onOpenNotes).toHaveBeenCalledOnce();
    expect(props.onOpenLibrary).toHaveBeenCalledOnce();
    expect(store.patchCalls).toEqual([]);
  } finally {
    preferences.dispose();
  }
});

test("a denied contextual read cannot expose another workspace's confirmed Guided help", async () => {
  const { store, preferences, props, provider } = await fixture();
  try {
    store.assistance = {
      mode: AssistanceMode.Guided,
      source: AssistanceSource.Workspace,
      userDefaultExplicit: true,
      interactiveMode: AssistanceMode.Guided,
    };
    const view = render(
      <FrameworkRoot framework={provider}>
        <MyoxusUIProvider>
          <WorkspaceHomeAssistance {...props} />
        </MyoxusUIProvider>
      </FrameworkRoot>,
    );
    await screen.findByRole("button", { name: "Capture from a note" });
    const read = vi
      .spyOn(store, "getAssistance")
      .mockRejectedValueOnce(new Error("membership revoked"));
    view.rerender(
      <FrameworkRoot framework={provider}>
        <MyoxusUIProvider>
          <WorkspaceHomeAssistance {...props} workspaceId="workspace-b" />
        </MyoxusUIProvider>
      </FrameworkRoot>,
    );
    await vi.waitFor(() =>
      expect(read).toHaveBeenCalledWith("workspace-b", undefined, "actor-a"),
    );
    expect(
      screen.queryByRole("button", { name: "Capture from a note" }),
    ).toBeNull();
    expect(props.onNewTask).not.toHaveBeenCalled();
  } finally {
    preferences.dispose();
  }
});

test("native local Guided offers content and Library without advertising offline Tasks", async () => {
  const state = new MemoryMemento();
  state.set(localWorkspaceAssistanceKey("local-a"), AssistanceMode.Guided);
  render(
    <MyoxusUIProvider>
      <WorkspaceHomeAssistance
        server={null}
        workspaceId="local-a"
        local
        state={state}
        onNewTask={vi.fn()}
        onOpenNotes={vi.fn()}
        onOpenLibrary={vi.fn()}
      />
    </MyoxusUIProvider>,
  );
  await screen.findByRole("button", { name: "Library" });
  expect(screen.getByRole("button", { name: "All content" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
});
