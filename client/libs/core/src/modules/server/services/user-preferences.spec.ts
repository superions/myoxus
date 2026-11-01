// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthService } from "@myoxus/core/modules/server/services/auth";
import { ServerService } from "@myoxus/core/modules/server/services/server";
import {
  fromGraphQLWorkbenchToolLayouts,
  fromGraphQLWorkspaceDashboardLayouts,
  toGraphQLWorkbenchToolLayouts,
  toGraphQLWorkspaceDashboardLayouts,
  type UserPreferences,
  UserPreferencesStore,
} from "@myoxus/core/modules/server/stores/user-preferences";
import {
  AssistanceMode,
  AssistanceSource,
  WorkbenchToolId as GraphQLWorkbenchToolId,
  WorkbenchViewFamily as GraphQLWorkbenchViewFamily,
  WorkspaceDashboardDashletId as GraphQLWorkspaceDashboardDashletId,
  WorkspaceDashboardDashletSize as GraphQLWorkspaceDashboardDashletSize,
} from "@myoxus/graphql";
import { Framework } from "@myoxus/infra";
import { Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { UserPreferencesService } from "./user-preferences";

import {
  PreferenceStoreStub,
  serverPreferences,
} from "./user-preferences.test-fixtures";

describe("UserPreferencesService offline projection", () => {
  test("round-trips every stable Workbench family and tool identifier", () => {
    const layouts = [
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        viewFamily: "document-page" as const,
        orderedToolIds: [
          "outline",
          "document-info",
          "calendar",
          "agenda",
          "activity",
          "comment",
          "chat",
          "export",
          "analytics",
        ] as const,
        visibleToolIds: ["outline"] as const,
        collapsedToolIds: [] as const,
      },
      {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        viewFamily: "document-edgeless" as const,
        orderedToolIds: ["frame"] as const,
        visibleToolIds: ["frame"] as const,
        collapsedToolIds: [] as const,
      },
      {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        viewFamily: "journal" as const,
        orderedToolIds: ["calendar"] as const,
        visibleToolIds: ["calendar"] as const,
        collapsedToolIds: ["calendar"] as const,
      },
      {
        workspaceId: "44444444-4444-4444-8444-444444444444",
        viewFamily: "database" as const,
        orderedToolIds: ["database-settings"] as const,
        visibleToolIds: ["database-settings"] as const,
        collapsedToolIds: [] as const,
      },
      {
        workspaceId: "55555555-5555-4555-8555-555555555555",
        viewFamily: "graph" as const,
        orderedToolIds: ["graph-details"] as const,
        visibleToolIds: ["graph-details"] as const,
        collapsedToolIds: [] as const,
      },
    ];

    expect(
      fromGraphQLWorkbenchToolLayouts(toGraphQLWorkbenchToolLayouts(layouts)),
    ).toEqual(layouts);
  });

  test("round-trips every dashboard identifier and semantic size", () => {
    const layouts = [
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        orderedDashletIds: [
          "today",
          "tasks",
          "new-documents",
          "reminders",
          "recently-edited",
          "activity",
        ] as const,
        dashletSizes: {
          today: "wide",
          tasks: "wide",
          "new-documents": "compact",
          reminders: "standard",
          "recently-edited": "compact",
          activity: "wide",
        } as const,
      },
    ];

    expect(
      fromGraphQLWorkspaceDashboardLayouts(
        toGraphQLWorkspaceDashboardLayouts(layouts),
      ),
    ).toEqual(layouts);
  });

  test("keeps a failed merged patch and acknowledges it once on reconnect", async () => {
    const accounts = new Subject<{ id: string } | null>();
    const store = new PreferenceStoreStub();
    const framework = new Framework();
    framework
      .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
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
    const service = framework.provider().get(UserPreferencesService);

    accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(service.userPreferences$.value).toBeDefined(),
    );

    store.failPatches = true;
    await service.update({ colorMode: "dark" });
    await service.update({ journalShowCalendarWeeks: false });
    expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({
      colorMode: "dark",
      journalShowCalendarWeeks: false,
    });
    expect(service.error$.value).toEqual(new Error("offline"));

    store.patchCalls = [];
    store.failPatches = false;
    await service.revalidate();

    expect(store.patchCalls).toEqual([
      { colorMode: "dark", journalShowCalendarWeeks: false },
    ]);
    expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({});
    expect(service.userPreferences$.value?.effectiveValues).toMatchObject({
      colorMode: "dark",
      journalShowCalendarWeeks: false,
    });
    service.dispose();
  });

  test("rolls back a failed confirmed creator save while retaining other pending preferences", async () => {
    const accounts = new Subject<{ id: string } | null>();
    const store = new PreferenceStoreStub();
    const framework = new Framework();
    framework
      .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
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
    const service = framework.provider().get(UserPreferencesService);
    accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(service.userPreferences$.value).toBeDefined(),
    );
    store.failPatches = true;
    await service.update({ colorMode: "dark" });
    await expect(
      service.update(
        { notifyCreatedDocuments: false },
        { rollbackOnError: true },
      ),
    ).rejects.toThrow("offline");
    expect(
      service.userPreferences$.value?.effectiveValues.notifyCreatedDocuments,
    ).toBe(true);
    expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({
      colorMode: "dark",
    });
    expect(service.error$.value).toEqual(new Error("offline"));
    store.failPatches = false;
    await service.update(
      { notifyCreatedDocuments: false },
      { rollbackOnError: true },
    );
    expect(
      service.userPreferences$.value?.effectiveValues.notifyCreatedDocuments,
    ).toBe(false);
    expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({});
    service.dispose();
  });

  test("projects scoped Workbench set, reconnect and reset without materializing defaults", async () => {
    const accounts = new Subject<{ id: string } | null>();
    const store = new PreferenceStoreStub();
    const framework = new Framework();
    framework
      .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
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
    const service = framework.provider().get(UserPreferencesService);
    const layout = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      viewFamily: "document-page" as const,
      orderedToolIds: ["outline", "tags", "document-info"] as const,
      visibleToolIds: ["outline", "tags"] as const,
      collapsedToolIds: ["tags"] as const,
    };

    accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(service.userPreferences$.value).toBeDefined(),
    );
    expect(service.workbenchToolLayouts$.value).toEqual({
      confirmed: null,
      projected: null,
      syncStatus: "confirmed",
    });

    store.failPatches = true;
    await service.updateWorkbenchToolLayout({
      ...layout,
      orderedToolIds: [...layout.orderedToolIds],
      visibleToolIds: [...layout.visibleToolIds],
      collapsedToolIds: [...layout.collapsedToolIds],
    });
    expect(service.workbenchToolLayouts$.value).toEqual({
      confirmed: null,
      projected: [layout],
      syncStatus: "pending",
    });
    expect(store.patchCalls.at(-1)).toEqual({
      workbenchToolLayouts: [
        {
          workspaceId: layout.workspaceId,
          viewFamily: GraphQLWorkbenchViewFamily.DocumentPage,
          orderedToolIds: [
            GraphQLWorkbenchToolId.Outline,
            GraphQLWorkbenchToolId.Tags,
            GraphQLWorkbenchToolId.DocumentInfo,
          ],
          visibleToolIds: [
            GraphQLWorkbenchToolId.Outline,
            GraphQLWorkbenchToolId.Tags,
          ],
          collapsedToolIds: [GraphQLWorkbenchToolId.Tags],
        },
      ],
    });

    store.failPatches = false;
    await service.revalidate();
    expect(
      service.getWorkbenchToolLayout(layout.workspaceId, "document-page"),
    ).toEqual(layout);
    expect(service.workbenchToolLayouts$.value.syncStatus).toBe("confirmed");

    store.failPatches = true;
    await service.resetWorkbenchToolLayout(layout.workspaceId, "document-page");
    expect(service.workbenchToolLayouts$.value).toMatchObject({
      projected: null,
      syncStatus: "pending",
    });
    store.failPatches = false;
    await service.revalidate();
    expect(service.workbenchToolLayouts$.value).toEqual({
      confirmed: null,
      projected: null,
      syncStatus: "confirmed",
    });
    service.dispose();
  });

  test("merges dashboard edits offline, preserves other workspaces, and resets only the current workspace", async () => {
    const accounts = new Subject<{ id: string } | null>();
    const store = new PreferenceStoreStub();
    const framework = new Framework();
    framework
      .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
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
    const service = framework.provider().get(UserPreferencesService);
    const workspaceA = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      orderedDashletIds: [
        "today",
        "new-documents",
        "reminders",
        "recently-edited",
        "activity",
      ] as const,
      dashletSizes: { today: "wide" as const },
    };
    const workspaceB = {
      ...workspaceA,
      workspaceId: "22222222-2222-4222-8222-222222222222",
    };

    accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(service.userPreferences$.value).toBeDefined(),
    );

    store.failPatches = true;
    await service.updateWorkspaceDashboardLayout(workspaceA);
    await service.updateWorkspaceDashboardLayout(workspaceB);
    await service.updateWorkspaceDashboardLayout({
      ...workspaceA,
      orderedDashletIds: [
        "activity",
        "today",
        "new-documents",
        "reminders",
        "recently-edited",
      ],
      dashletSizes: { today: "wide", activity: "wide" },
    });

    expect(service.workspaceDashboardLayouts$.value).toMatchObject({
      projected: [
        workspaceB,
        {
          workspaceId: workspaceA.workspaceId,
          orderedDashletIds: [
            "activity",
            "today",
            "new-documents",
            "reminders",
            "recently-edited",
          ],
          dashletSizes: { activity: "wide" },
        },
      ],
      syncStatus: "pending",
    });
    expect(store.getCached("server-a", "user-a")?.pendingPatch).toMatchObject({
      workspaceDashboardLayouts: [
        {
          workspaceId: workspaceB.workspaceId,
          orderedDashletIds: [
            GraphQLWorkspaceDashboardDashletId.Today,
            GraphQLWorkspaceDashboardDashletId.NewDocuments,
            GraphQLWorkspaceDashboardDashletId.Reminders,
            GraphQLWorkspaceDashboardDashletId.RecentlyEdited,
            GraphQLWorkspaceDashboardDashletId.Activity,
          ],
        },
        {
          workspaceId: workspaceA.workspaceId,
          orderedDashletIds: [
            GraphQLWorkspaceDashboardDashletId.Activity,
            GraphQLWorkspaceDashboardDashletId.Today,
            GraphQLWorkspaceDashboardDashletId.NewDocuments,
            GraphQLWorkspaceDashboardDashletId.Reminders,
            GraphQLWorkspaceDashboardDashletId.RecentlyEdited,
          ],
          dashletSizes: [
            {
              dashletId: GraphQLWorkspaceDashboardDashletId.Today,
              size: GraphQLWorkspaceDashboardDashletSize.Wide,
            },
            {
              dashletId: GraphQLWorkspaceDashboardDashletId.Activity,
              size: GraphQLWorkspaceDashboardDashletSize.Wide,
            },
          ],
        },
      ],
    });

    store.failPatches = false;
    await service.revalidate();
    expect(service.workspaceDashboardLayouts$.value.syncStatus).toBe(
      "confirmed",
    );
    expect(service.getWorkspaceDashboardLayout(workspaceB.workspaceId)).toEqual(
      workspaceB,
    );

    store.failPatches = true;
    await service.resetWorkspaceDashboardLayout(workspaceA.workspaceId);
    expect(service.workspaceDashboardLayouts$.value).toMatchObject({
      projected: [workspaceB],
      syncStatus: "pending",
    });
    store.failPatches = false;
    await service.revalidate();
    expect(
      service.getWorkspaceDashboardLayout(workspaceA.workspaceId),
    ).toBeNull();
    expect(service.getWorkspaceDashboardLayout(workspaceB.workspaceId)).toEqual(
      workspaceB,
    );
    service.dispose();
  });

  test("isolates pending projections across account and server scopes", async () => {
    const store = new PreferenceStoreStub();
    const createService = (serverId: string) => {
      const accounts = new Subject<{ id: string } | null>();
      const framework = new Framework();
      framework
        .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
        .service(AuthService, {
          session: { account$: accounts },
        } as unknown as AuthService)
        .service(ServerService, {
          server: { id: serverId },
        } as unknown as ServerService)
        .service(UserPreferencesService, [
          UserPreferencesStore,
          AuthService,
          ServerService,
        ]);
      return {
        accounts,
        service: framework.provider().get(UserPreferencesService),
      };
    };
    const layout = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      viewFamily: "database" as const,
      orderedToolIds: ["database-settings" as const],
      visibleToolIds: ["database-settings" as const],
      collapsedToolIds: [],
    };
    const serverA = createService("server-a");
    serverA.accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(serverA.service.userPreferences$.value).toBeDefined(),
    );
    const shell = createService("server-a");
    shell.accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(shell.service.userPreferences$.value).toBeDefined(),
    );
    store.failPatches = true;
    await serverA.service.update({ colorMode: "light" });
    expect(
      shell.service.userPreferences$.value?.effectiveValues.colorMode,
    ).toBe("light");
    expect(store.patchCalls).toEqual([{ colorMode: "light" }]);
    shell.accounts.next(null);
    await serverA.service.update({ colorMode: "dark" });
    expect(shell.service.userPreferences$.value).toBeUndefined();
    shell.service.dispose();
    await serverA.service.updateWorkbenchToolLayout(layout);

    serverA.accounts.next({ id: "user-b" });
    expect(serverA.service.workbenchToolLayouts$.value.projected).toBeNull();
    serverA.accounts.next({ id: "user-a" });
    expect(serverA.service.workbenchToolLayouts$.value.projected).toEqual([
      layout,
    ]);

    const serverB = createService("server-b");
    serverB.accounts.next({ id: "user-a" });
    expect(serverB.service.workbenchToolLayouts$.value.projected).toBeNull();
    expect([...store.cache.keys()]).toContain("server-a:user-a");
    expect([...store.cache.keys()]).not.toContain("server-b:user-a");

    serverA.service.dispose();
    serverB.service.dispose();
  });
});

describe("confirmed assistance preferences", () => {
  async function setup() {
    const accounts = new Subject<{ id: string } | null>();
    const store = new PreferenceStoreStub();
    const framework = new Framework();
    framework
      .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
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
    const service = framework.provider().get(UserPreferencesService);
    accounts.next({ id: "user-a" });
    await vi.waitFor(() =>
      expect(service.confirmedPreferences$.value).toBeDefined(),
    );
    return { service, store, accounts };
  }

  test("a failed mode save never enters the offline queue or replays on reconnect", async () => {
    const { service, store } = await setup();
    try {
      store.failPatches = true;
      await service.update({ colorMode: "dark" });
      await expect(
        service.updateAssistance(AssistanceMode.Automatic, "workspace-a"),
      ).rejects.toThrow("offline");
      expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({
        colorMode: "dark",
      });
      expect((await service.getAssistance("workspace-a")).mode).toBe(
        AssistanceMode.Manual,
      );
      store.failPatches = false;
      store.patchCalls = [];
      await service.revalidate();
      expect(store.patchCalls).toEqual([{ colorMode: "dark" }]);
    } finally {
      service.dispose();
    }
  });

  test("resetting one Project sends only its native delta and returns contextual server inheritance", async () => {
    const { service, store } = await setup();
    try {
      store.assistance = {
        mode: AssistanceMode.Guided,
        source: AssistanceSource.Workspace,
        userDefaultExplicit: true,
        interactiveMode: AssistanceMode.Guided,
      };
      const read = vi.spyOn(store, "getAssistance");
      expect(
        await service.updateAssistance(null, "workspace-a", "project-a"),
      ).toEqual(store.assistance);
      expect(store.patchCalls).toEqual([
        {
          projectAssistanceOverrides: [
            { workspaceId: "workspace-a", projectId: "project-a", mode: null },
          ],
        },
      ]);
      expect(read).toHaveBeenCalledWith("workspace-a", "project-a", "user-a");
      expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({});
    } finally {
      service.dispose();
    }
  });

  test("a late acknowledged mode save rejects after account switch without altering the new account", async () => {
    const { service, store, accounts } = await setup();
    try {
      let acknowledge: (value: UserPreferences) => void = () => {
        throw new Error("not pending");
      };
      vi.spyOn(store, "patchRemote").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      );
      const save = service.updateAssistance(AssistanceMode.Automatic);
      const rejection = expect(save).rejects.toThrow("owner changed");
      accounts.next({ id: "user-b" });
      await vi.waitFor(() =>
        expect(store.getCached("server-a", "user-b")).toBeDefined(),
      );
      acknowledge({
        ...serverPreferences(),
        values: {
          ...serverPreferences().values,
          assistanceMode: AssistanceMode.Automatic,
        },
      });
      await rejection;
      expect(service.preferenceIdentity$.value).toBe(
        JSON.stringify(["server-a", "user-b"]),
      );
      expect(
        service.confirmedPreferences$.value?.values.assistanceMode,
      ).toBeNull();
      expect(store.getCached("server-a", "user-b")?.pendingPatch).toEqual({});
    } finally {
      service.dispose();
    }
  });

  test("ordinary edits made during a confirmed save remain queued and synchronize independently", async () => {
    const { service, store } = await setup();
    try {
      let acknowledge: (value: UserPreferences) => void = () => {
        throw new Error("not pending");
      };
      vi.spyOn(store, "patchRemote").mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve;
          }),
      );
      const save = service.updateAssistance(AssistanceMode.Guided);
      const ordinary = service.update({ colorMode: "dark" });
      expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({
        colorMode: "dark",
      });
      acknowledge(serverPreferences());
      await Promise.all([save, ordinary]);
      await vi.waitFor(() =>
        expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({}),
      );
      expect(store.patchCalls).toEqual([{ colorMode: "dark" }]);
      expect(
        service.confirmedPreferences$.value?.effectiveValues.colorMode,
      ).toBe("dark");
    } finally {
      service.dispose();
    }
  });
});
