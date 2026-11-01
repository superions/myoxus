// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  executeWorkspaceContentOperationMutation,
  WorkspaceContentConfirmationKindType,
  WorkspaceContentGitSyncChoiceType,
  workspaceContentOperationCapabilitiesQuery,
  workspaceContentOperationQuery,
  WorkspaceContentOperationStatusType,
  WorkspaceContentOperationKindType,
  workspaceContentPreflightMutation,
  workspaceContentRedirectQuery,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { Framework, LiveData } from "@myoxus/infra";
import { afterEach, describe, expect, test, vi } from "vitest";

import { OrganizeService } from "../organize";
import { WorkspaceServerService } from "../server";
import { WorkspaceService, WorkspacesService } from "../workspace";
import { WorkspaceContentOperationService } from "./service";

function createHarness({
  flavour = "server-a",
}: {
  flavour?: string;
} = {}) {
  const account$ = new LiveData<{ id: string } | null>({ id: "user-1" });
  const gql = vi.fn<
    (request: { query: unknown; variables?: any }) => Promise<any>
  >(async ({ query }) => {
    if (query === workspaceContentOperationCapabilitiesQuery) {
      return {
        workspace: {
          permissions: {
            Workspace_Read: true,
            Workspace_Organize_Update: true,
            Workspace_Content_Transfer: true,
          },
        },
      };
    }
    throw new Error("Unexpected query");
  });
  const server = { account$, gql };
  const workspace = {
    id: "source-workspace",
    flavour,
    meta: { id: "source-workspace", flavour, name: "Source" },
  };
  const openByWorkspaceId = vi.fn();
  const waitForRevalidation = vi.fn(async () => undefined);
  const workspacesService = {
    list: {
      revalidate: vi.fn(),
      waitForRevalidation,
      workspaces$: new LiveData([
        workspace.meta,
        { id: "target-b", flavour, name: "Beta" },
        { id: "target-a", flavour, name: "Alpha" },
        { id: "foreign", flavour: "server-b", name: "Foreign" },
        { id: "local", flavour: "local", name: "Local" },
      ]),
    },
    openByWorkspaceId,
  } as unknown as WorkspacesService;
  const framework = new Framework();
  framework
    .service(WorkspaceService, { workspace } as WorkspaceService)
    .service(WorkspaceServerService, {
      server: flavour === "local" ? null : server,
    } as WorkspaceServerService)
    .service(WorkspacesService, workspacesService)
    .service(WorkspaceContentOperationService, [
      WorkspaceService,
      WorkspaceServerService,
      WorkspacesService,
    ]);
  const service = framework.provider().get(WorkspaceContentOperationService);
  return {
    account$,
    gql,
    openByWorkspaceId,
    server,
    service,
    waitForRevalidation,
    workspacesService,
  };
}

describe("WorkspaceContentOperationService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("never projects commands for a local workspace", async () => {
    const { gql, service } = createHarness({ flavour: "local" });

    await service.refreshAvailability(true);

    expect(service.availability$.value.status).toBe("unavailable");
    expect(service.canStart(WorkspaceContentOperationKindType.Copy)).toBe(
      false,
    );
    expect(gql).not.toHaveBeenCalled();
    service.dispose();
  });

  test("invalidates immediately offline and revalidates after reconnect", async () => {
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const { gql, service } = createHarness();

    await service.refreshAvailability(true);
    expect(service.availability$.value.status).toBe("available");

    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(service.availability$.value.status).toBe("unavailable");

    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => {
      expect(service.availability$.value.status).toBe("available");
    });
    expect(gql).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  test("offers Extract to workspace managers without enabling Move", async () => {
    const { gql, service } = createHarness();
    gql.mockResolvedValue({
      workspace: {
        permissions: {
          Workspace_Read: true,
          Workspace_Organize_Update: true,
          Workspace_Content_Transfer: false,
        },
      },
    });
    await service.refreshAvailability(true);
    expect(
      service.canStart(WorkspaceContentOperationKindType.ExtractFolder),
    ).toBe(true);
    expect(service.canStart(WorkspaceContentOperationKindType.Move)).toBe(
      false,
    );
    service.dispose();
  });

  test("keeps fresh server capabilities and targets inside the current server scope", async () => {
    vi.useFakeTimers();
    const { account$, gql, service } = createHarness();

    await service.refreshAvailability(true);

    expect(service.availability$.value).toMatchObject({
      status: "available",
      targets: [
        { id: "target-a", flavour: "server-a" },
        { id: "target-b", flavour: "server-a" },
      ],
    });
    expect(service.canStart(WorkspaceContentOperationKindType.Move)).toBe(true);
    expect(gql).toHaveBeenCalledTimes(1);

    account$.next(null);
    expect(service.availability$.value.status).toBe("unavailable");

    account$.next({ id: "user-1" });
    await service.refreshAvailability(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.availability$.value.status).toBe("available");
    expect(gql).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  test.each([
    WorkspaceContentOperationKindType.Copy,
    WorkspaceContentOperationKindType.Move,
  ])("sends %s preflight over LAN HTTP without randomUUID", async (kind) => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const { gql, service } = createHarness();
    const preview = { revision: "http-preview" };
    await service.refreshAvailability(true);
    const capabilities = gql.getMockImplementation()!;
    gql.mockImplementation(async (request) =>
      request.query === workspaceContentPreflightMutation
        ? { workspaceContentPreflight: preview }
        : capabilities(request),
    );
    const input = {
      kind,
      targetWorkspaceId: "target-a",
      selection: {
        type: "resources" as const,
        resources: [
          { id: "doc-1", kind: WorkspaceContentResourceKindType.Document },
        ],
      },
    };
    try {
      await expect(service.preflight(input)).resolves.toEqual(preview);
      await expect(service.preflight(input)).resolves.toEqual(preview);
      const requests = gql.mock.calls.filter(
        ([request]) => request.query === workspaceContentPreflightMutation,
      );
      expect(requests).toHaveLength(2);
      const ids = requests.map(
        ([request]) => request.variables.input.idempotencyId,
      );
      for (const id of ids) {
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      expect(ids[0]).not.toBe(ids[1]);
    } finally {
      service.dispose();
    }
  });

  test("does not drop the explicit Disconnect choice from Extract transport", async () => {
    const { gql, service } = createHarness();
    const capabilities = gql.getMockImplementation()!;
    gql.mockImplementation(async (request) =>
      request.query === workspaceContentPreflightMutation
        ? { workspaceContentPreflight: { revision: "disconnect" } }
        : capabilities(request),
    );
    try {
      await service.preflight({
        kind: WorkspaceContentOperationKindType.ExtractFolder,
        selection: {
          type: "folder",
          folderId: "folder",
          label: "Selected folder",
        },
        extractWorkspaceName: "Detached workspace",
        gitSyncChoice: WorkspaceContentGitSyncChoiceType.Disconnect,
      });
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: workspaceContentPreflightMutation,
          variables: {
            input: expect.objectContaining({
              gitSyncChoice: WorkspaceContentGitSyncChoiceType.Disconnect,
              folderId: "folder",
              extractWorkspaceName: "Detached workspace",
            }),
          },
        }),
      );
    } finally {
      service.dispose();
    }
  });

  test("revalidates before preview and sends the exact server confirmation projection", async () => {
    const { gql, service } = createHarness();
    gql.mockImplementation(async ({ query, variables }) => {
      if (query === workspaceContentOperationCapabilitiesQuery) {
        return {
          workspace: {
            permissions: {
              Workspace_Read: true,
              Workspace_Organize_Update: true,
              Workspace_Content_Transfer: true,
            },
          },
        };
      }
      if (query === workspaceContentPreflightMutation) {
        expect(variables.input).toMatchObject({
          kind: WorkspaceContentOperationKindType.Move,
          sourceWorkspaceId: "source-workspace",
          targetWorkspaceId: "target-a",
          resources: [
            {
              id: "doc-1",
              kind: WorkspaceContentResourceKindType.Document,
            },
          ],
        });
        return {
          workspaceContentPreflight: {
            revision: "revision-1",
            blockers: [],
            conflicts: [],
            membershipImpactCount: 1,
            membershipImpacts: [],
            resourceCount: 1,
            resourceCounts: [],
            operation: {
              id: "operation-1",
              kind: WorkspaceContentOperationKindType.Move,
              sourceWorkspaceId: "source-workspace",
              targetWorkspaceId: "target-a",
              status: "Previewed",
              revision: "revision-1",
              errorCode: null,
              errorMessage: null,
              errorPhase: null,
              originOperationId: null,
            },
            requiredConfirmations: [
              {
                kind: WorkspaceContentConfirmationKindType.AddTargetMember,
                userId: "00000000-0000-0000-0000-000000000001",
                role: "Reader",
                resource: null,
              },
            ],
          },
        };
      }
      if (query === executeWorkspaceContentOperationMutation) {
        expect(variables.input).toEqual({
          operationId: "operation-1",
          revision: "revision-1",
          confirmations: [
            {
              kind: WorkspaceContentConfirmationKindType.AddTargetMember,
              userId: "00000000-0000-0000-0000-000000000001",
              role: "Reader",
              resource: undefined,
              resourceWorkspaceId: undefined,
            },
          ],
        });
        return {
          executeWorkspaceContentOperation: {
            id: "operation-1",
            kind: WorkspaceContentOperationKindType.Move,
            sourceWorkspaceId: "source-workspace",
            targetWorkspaceId: "target-a",
            status: "Queued",
            revision: "revision-1",
            errorCode: null,
            errorMessage: null,
            errorPhase: null,
            originOperationId: null,
          },
        };
      }
      throw new Error("Unexpected query");
    });

    const preview = await service.preflight({
      kind: WorkspaceContentOperationKindType.Move,
      selection: {
        type: "resources",
        resources: [
          {
            id: "doc-1",
            kind: WorkspaceContentResourceKindType.Document,
          },
        ],
      },
      targetWorkspaceId: "target-a",
    });
    const operation = await service.execute(preview);

    expect(operation.status).toBe("Queued");
    expect(
      gql.mock.calls.filter(
        ([request]) =>
          request.query === workspaceContentOperationCapabilitiesQuery,
      ),
    ).toHaveLength(2);
    service.dispose();
  });

  test("accepts only permission-checked redirects inside the current server scope", async () => {
    const { gql, service } = createHarness();
    let redirectedWorkspaceId = "target-a";
    gql.mockImplementation(async ({ query }) => {
      if (query === workspaceContentOperationCapabilitiesQuery) {
        return {
          workspace: {
            permissions: {
              Workspace_Read: true,
              Workspace_Organize_Update: true,
              Workspace_Content_Transfer: true,
            },
          },
        };
      }
      if (query === workspaceContentRedirectQuery) {
        return {
          workspaceContentRedirect: {
            workspaceId: redirectedWorkspaceId,
            kind: WorkspaceContentResourceKindType.Document,
            id: "target-doc",
          },
        };
      }
      throw new Error("Unexpected query");
    });

    await expect(
      service.resolveRedirect({
        workspaceId: "target-a",
        resource: {
          kind: WorkspaceContentResourceKindType.Document,
          id: "target-doc",
        },
      }),
    ).resolves.toEqual({
      workspaceId: "target-a",
      kind: WorkspaceContentResourceKindType.Document,
      id: "target-doc",
    });

    redirectedWorkspaceId = "source-workspace";
    await expect(
      service.resolveRedirect({
        workspaceId: "target-a",
        resource: {
          kind: WorkspaceContentResourceKindType.Document,
          id: "target-doc",
        },
      }),
    ).resolves.toEqual({
      workspaceId: "source-workspace",
      kind: WorkspaceContentResourceKindType.Document,
      id: "target-doc",
    });

    redirectedWorkspaceId = "foreign";
    await expect(
      service.resolveRedirect({
        workspaceId: "target-a",
        resource: {
          kind: WorkspaceContentResourceKindType.Document,
          id: "target-doc",
        },
      }),
    ).rejects.toThrow("outside this server");
    service.dispose();
  });

  test("opens workspace links only after a fresh readable target projection", async () => {
    const { gql, service } = createHarness();
    let canReadTarget = true;
    gql.mockImplementation(async ({ query, variables }) => {
      if (query === workspaceContentOperationCapabilitiesQuery) {
        expect(variables).toEqual({ workspaceId: "target-a" });
        return {
          workspace: {
            permissions: {
              Workspace_Read: canReadTarget,
              Workspace_Organize_Update: false,
              Workspace_Content_Transfer: false,
            },
          },
        };
      }
      throw new Error("Unexpected query");
    });

    await expect(service.resolveWorkspaceHome("target-a")).resolves.toBe(
      "target-a",
    );

    canReadTarget = false;
    await expect(service.resolveWorkspaceHome("target-a")).resolves.toBeNull();

    const requestCount = gql.mock.calls.length;
    await expect(service.resolveWorkspaceHome("foreign")).rejects.toThrow(
      "outside this server",
    );
    expect(gql).toHaveBeenCalledTimes(requestCount);
    service.dispose();
  });

  test("discovers a published Extract before checking its readable same-server target", async () => {
    const { gql, service, waitForRevalidation, workspacesService } =
      createHarness();
    const capabilities = gql.getMockImplementation()!;
    gql.mockImplementation(async (request) =>
      request.query === workspaceContentOperationQuery
        ? {
            workspaceContentOperation: {
              kind: WorkspaceContentOperationKindType.ExtractFolder,
              status: WorkspaceContentOperationStatusType.Succeeded,
              targetWorkspaceId: "new-target",
            },
          }
        : capabilities(request),
    );
    waitForRevalidation.mockImplementationOnce(async () => {
      expect(gql).not.toHaveBeenCalledWith(
        expect.objectContaining({ variables: { workspaceId: "new-target" } }),
      );
      workspacesService.list.workspaces$.value.push({
        id: "new-target",
        flavour: "server-a",
        name: "New",
      });
    });
    try {
      await expect(
        service.resolveExtractedWorkspace("published-extract"),
      ).resolves.toBe("new-target");
      expect(waitForRevalidation).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
    }
  });

  test("waits for remote Organizer sync and application before listing link folders", async () => {
    const { openByWorkspaceId, service } = createHarness();
    let organizerReady = false;
    const dispose = vi.fn();
    const stages: string[] = [];
    const waitForDocReady = vi.fn(async () => {
      stages.push("ready");
    });
    const waitForSynced = vi.fn(async () => {
      stages.push("synced");
      expect(organizerReady).toBe(false);
    });
    const waitForUpdated = vi.fn(async () => {
      stages.push("updated");
      organizerReady = true;
    });
    const targetFolder = {
      id: "folder-1",
      name$: { value: "Shared references" },
      type$: { value: "folder" },
      sortedChildren$: { value: [] },
    };
    const rootFolder = {
      get sortedChildren$() {
        return { value: organizerReady ? [targetFolder] : [] };
      },
    };
    const organize = {
      folderTree: { rootFolder },
    };
    openByWorkspaceId.mockReturnValue({
      workspace: {
        engine: { doc: { waitForDocReady, waitForSynced, waitForUpdated } },
        scope: {
          get(token: unknown) {
            expect(token).toBe(OrganizeService);
            return organize;
          },
        },
      },
      dispose,
    });

    await expect(service.targetLinkFolders("target-a")).resolves.toEqual([
      { id: "folder-1", name: "Shared references" },
    ]);
    expect(waitForDocReady).toHaveBeenCalledWith(
      "db$folders",
      expect.any(AbortSignal),
    );
    expect(stages).toEqual(["ready", "synced", "updated"]);
    expect(waitForSynced).toHaveBeenCalledWith(
      "db$folders",
      expect.any(AbortSignal),
    );
    expect(waitForUpdated).toHaveBeenCalledWith(
      "db$folders",
      expect.any(AbortSignal),
    );
    expect(dispose).toHaveBeenCalledOnce();
    service.dispose();
  });
});
