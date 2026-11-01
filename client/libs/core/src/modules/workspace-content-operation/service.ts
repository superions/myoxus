// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  cancelWorkspaceContentOperationMutation,
  executeWorkspaceContentOperationMutation,
  retryWorkspaceContentOperationMutation,
  undoWorkspaceContentOperationMutation,
  type WorkspaceContentConfirmationInput,
  workspaceContentOperationCapabilitiesQuery,
  WorkspaceContentOperationKindType,
  type WorkspaceContentOperationProjectionFragment,
  workspaceContentOperationQuery,
  WorkspaceContentOperationStatusType,
  type WorkspaceContentGitSyncChoiceType,
  type WorkspaceContentPreflightInput,
  workspaceContentPreflightMutation,
  type WorkspaceContentPreflightProjectionFragment,
  type WorkspaceContentRedirectInput,
  workspaceContentRedirectQuery,
  WorkspaceContentResourceKindType,
} from "@myoxus/graphql";
import { LiveData, Service } from "@myoxus/infra";
import { createOperationUuid } from "@myoxus/core/utils/uuid";

import { OrganizeService } from "../organize";
import type { WorkspaceServerService } from "../server";
import type {
  WorkspaceMetadata,
  WorkspaceService,
  WorkspacesService,
} from "../workspace";
import type { WorkspaceContentOperationSelection } from "./types";

const CAPABILITY_TTL_MS = 30_000;
const TARGET_ORGANIZER_DOC_ID = "db$folders";
const TARGET_ORGANIZER_TIMEOUT_MS = 10_000;

type WorkspaceContentCapabilities = {
  read: boolean;
  organize: boolean;
  transfer: boolean;
};

export type WorkspaceContentOperationAvailability =
  | { status: "unavailable"; targets: WorkspaceMetadata[] }
  | {
      status: "checking";
      targets: WorkspaceMetadata[];
      gitConfigured?: boolean;
    }
  | {
      status: "available";
      capabilities: WorkspaceContentCapabilities;
      checkedAt: number;
      targets: WorkspaceMetadata[];
      gitConfigured?: boolean;
    };

export type WorkspaceContentLinkFolder = {
  id: string;
  name: string;
};

export type WorkspaceContentLinkPlacement = {
  entryId: string;
  parentId: string;
  index: string;
};

/**
 * Online-only boundary for cross-workspace content operations.
 *
 * The service deliberately keeps no persisted capability or operation cache.
 * Every mutating stage revalidates the authenticated server projection, while
 * disconnect, auth loss, workspace disposal and TTL expiry remove commands.
 */
export class WorkspaceContentOperationService extends Service {
  readonly availability$ = new LiveData<WorkspaceContentOperationAvailability>({
    status: "unavailable",
    targets: [],
  });

  private capabilityRequest: Promise<void> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly workspacesService: WorkspacesService,
  ) {
    super();

    if (typeof window !== "undefined") {
      const handleOffline = () => this.invalidate();
      const handleOnline = () => {
        this.invalidate();
        void this.refreshAvailability(true);
      };
      window.addEventListener("offline", handleOffline);
      window.addEventListener("online", handleOnline);
      this.disposables.push(() => {
        window.removeEventListener("offline", handleOffline);
        window.removeEventListener("online", handleOnline);
      });
    }

    let initialAccountEmission = true;
    const accountSubscription =
      this.workspaceServerService.server?.account$.subscribe((account) => {
        if (initialAccountEmission) {
          initialAccountEmission = false;
          return;
        }
        this.invalidate();
        if (account) void this.refreshAvailability(true);
      });
    if (accountSubscription) {
      this.disposables.push(() => accountSubscription.unsubscribe());
    }
    this.disposables.push(() => this.clearStaleTimer());
  }

  canStart(kind: WorkspaceContentOperationKindType) {
    const state = this.availability$.value;
    if (state.status !== "available") return false;
    if (kind === WorkspaceContentOperationKindType.ExtractFolder) {
      return state.capabilities.organize;
    }
    if (kind === WorkspaceContentOperationKindType.Move) {
      return state.capabilities.transfer;
    }
    return state.capabilities.read;
  }

  async refreshAvailability(force = false) {
    if (this.capabilityRequest) {
      await this.capabilityRequest;
      return;
    }
    const current = this.availability$.value;
    if (
      !force &&
      current.status === "available" &&
      Date.now() - current.checkedAt < CAPABILITY_TTL_MS
    ) {
      return;
    }

    const workspace = this.workspaceService.workspace;
    const server = this.workspaceServerService.server;
    if (
      workspace.flavour === "local" ||
      !server ||
      (typeof navigator !== "undefined" && navigator.onLine === false) ||
      !server.account$.value
    ) {
      this.invalidate();
      return;
    }

    this.availability$.next({
      status: "checking",
      targets: this.sameServerTargets(),
      gitConfigured:
        current.status !== "unavailable" ? current.gitConfigured : undefined,
    });
    this.capabilityRequest = (async () => {
      try {
        const result = await server.gql({
          query: workspaceContentOperationCapabilitiesQuery,
          variables: { workspaceId: workspace.id },
        });
        if (!result.workspace) {
          this.invalidate();
          return;
        }
        const permissions = result.workspace.permissions;
        this.availability$.next({
          status: "available",
          checkedAt: Date.now(),
          targets: this.sameServerTargets(),
          gitConfigured: Boolean(result.workspace.gitSyncProfile),
          capabilities: {
            read: permissions.Workspace_Read,
            organize: permissions.Workspace_Organize_Update,
            transfer: permissions.Workspace_Content_Transfer,
          },
        });
        this.scheduleExpiry();
      } catch {
        this.invalidate();
      }
    })().finally(() => {
      this.capabilityRequest = null;
    });
    await this.capabilityRequest;
  }

  async preflight(input: {
    kind: WorkspaceContentOperationKindType;
    selection: WorkspaceContentOperationSelection;
    targetWorkspaceId?: string;
    extractWorkspaceName?: string;
    gitSyncChoice?: WorkspaceContentGitSyncChoiceType;
    linkPlacement?: WorkspaceContentLinkPlacement;
  }): Promise<WorkspaceContentPreflightProjectionFragment> {
    await this.assertFreshCapability(input.kind);
    const workspace = this.workspaceService.workspace;
    const variables: WorkspaceContentPreflightInput = {
      idempotencyId: createOperationUuid(),
      kind: input.kind,
      sourceWorkspaceId: workspace.id,
      targetWorkspaceId: input.targetWorkspaceId,
      extractWorkspaceName: input.extractWorkspaceName,
      gitSyncChoice: input.gitSyncChoice,
      ...(input.selection.type === "folder"
        ? input.kind === WorkspaceContentOperationKindType.ExtractFolder
          ? { folderId: input.selection.folderId }
          : {
              resources: [
                {
                  id: input.selection.folderId,
                  kind: WorkspaceContentResourceKindType.Folder,
                },
              ],
            }
        : { resources: input.selection.resources }),
      ...(input.linkPlacement
        ? {
            linkEntryId: input.linkPlacement.entryId,
            linkParentId: input.linkPlacement.parentId,
            linkIndex: input.linkPlacement.index,
          }
        : {}),
    };
    const result = await this.requireServer().gql({
      query: workspaceContentPreflightMutation,
      variables: { input: variables },
    });
    return result.workspaceContentPreflight;
  }

  async execute(
    preview: WorkspaceContentPreflightProjectionFragment,
  ): Promise<WorkspaceContentOperationProjectionFragment> {
    if (
      preview.operation.sourceWorkspaceId === this.workspaceService.workspace.id
    ) {
      await this.assertFreshCapability(preview.operation.kind);
    } else {
      // Undo is authorized in its actual source, not the open original workspace.
      const result = await this.requireServer().gql({
        query: workspaceContentOperationCapabilitiesQuery,
        variables: { workspaceId: preview.operation.sourceWorkspaceId },
      });
      if (!result.workspace?.permissions.Workspace_Content_Transfer) {
        throw new Error("Workspace content operation is unavailable");
      }
    }
    const confirmations: WorkspaceContentConfirmationInput[] =
      preview.requiredConfirmations.map((confirmation) => ({
        kind: confirmation.kind,
        userId: confirmation.userId,
        role: confirmation.role,
        resource: confirmation.resource
          ? {
              kind: confirmation.resource.kind,
              id: confirmation.resource.id,
            }
          : undefined,
        resourceWorkspaceId: confirmation.resource?.workspaceId ?? undefined,
      }));
    const result = await this.requireServer().gql({
      query: executeWorkspaceContentOperationMutation,
      variables: {
        input: {
          operationId: preview.operation.id,
          revision: preview.revision,
          confirmations,
        },
      },
    });
    return result.executeWorkspaceContentOperation;
  }

  async operation(operationId: string) {
    const result = await this.requireServer().gql({
      query: workspaceContentOperationQuery,
      variables: { operationId },
    });
    if (
      result.workspaceContentOperation.status ===
      WorkspaceContentOperationStatusType.Succeeded
    ) {
      this.workspacesService.list.revalidate();
    }
    return result.workspaceContentOperation;
  }

  async cancel(operationId: string) {
    const result = await this.requireServer().gql({
      query: cancelWorkspaceContentOperationMutation,
      variables: { operationId },
    });
    return result.cancelWorkspaceContentOperation;
  }

  async retry(operationId: string) {
    await this.refreshAvailability(true);
    const result = await this.requireServer().gql({
      query: retryWorkspaceContentOperationMutation,
      variables: { operationId },
    });
    return result.retryWorkspaceContentOperation;
  }

  async undo(originOperationId: string) {
    const result = await this.requireServer().gql({
      query: undoWorkspaceContentOperationMutation,
      variables: { originOperationId, idempotencyId: createOperationUuid() },
    });
    return result.undoWorkspaceContentOperation;
  }

  async resolveRedirect(input: WorkspaceContentRedirectInput) {
    await this.refreshAvailability(true);
    const result = await this.requireServer().gql({
      query: workspaceContentRedirectQuery,
      variables: { input },
    });
    const redirect = result.workspaceContentRedirect;
    if (redirect) {
      // A moved link target can now live in its containing workspace. Only
      // operation destinations exclude the current workspace, not read routes.
      if (redirect.workspaceId !== this.workspaceService.workspace.id) {
        this.assertSameServerTarget(redirect.workspaceId);
      }
    }
    return redirect;
  }

  async resolveWorkspaceHome(targetWorkspaceId: string) {
    if (targetWorkspaceId !== this.workspaceService.workspace.id) {
      this.assertSameServerTarget(targetWorkspaceId);
    }
    const result = await this.requireServer().gql({
      query: workspaceContentOperationCapabilitiesQuery,
      variables: { workspaceId: targetWorkspaceId },
    });
    return result.workspace?.permissions.Workspace_Read
      ? targetWorkspaceId
      : null;
  }

  /** A published Extract can precede discovery in the reactive Workspace list. */
  async resolveExtractedWorkspace(operationId: string) {
    const operation = await this.operation(operationId);
    if (
      operation.kind !== WorkspaceContentOperationKindType.ExtractFolder ||
      operation.status !== WorkspaceContentOperationStatusType.Succeeded ||
      !operation.targetWorkspaceId
    ) {
      return null;
    }
    const signal = AbortSignal.timeout(10_000);
    await this.workspacesService.list.waitForRevalidation(signal);
    await this.workspacesService.list.workspaces$.waitFor(
      (workspaces) =>
        workspaces.some(
          (workspace) => workspace.id === operation.targetWorkspaceId,
        ),
      signal,
    );
    return this.resolveWorkspaceHome(operation.targetWorkspaceId);
  }

  async targetLinkFolders(
    targetWorkspaceId: string,
  ): Promise<WorkspaceContentLinkFolder[]> {
    return this.withTargetOrganizer(targetWorkspaceId, (organize) => {
      const folders: WorkspaceContentLinkFolder[] = [];
      const collect = (nodes: Array<typeof organize.folderTree.rootFolder>) => {
        for (const node of nodes) {
          if (node.type$.value !== "folder" || !node.id) continue;
          folders.push({
            id: node.id,
            name: node.name$.value,
          });
          collect(node.sortedChildren$.value);
        }
      };
      collect(organize.folderTree.rootFolder.sortedChildren$.value);
      return folders;
    });
  }

  async createLinkPlacement(
    targetWorkspaceId: string,
    parentId: string,
  ): Promise<WorkspaceContentLinkPlacement> {
    return this.withTargetOrganizer(targetWorkspaceId, (organize) => {
      const parent = organize.folderTree.folderNode$(parentId).value;
      if (!parent || parent.type$.value !== "folder") {
        throw new Error("Workspace content target folder is unavailable");
      }
      return {
        entryId: createOperationUuid(),
        parentId,
        index: parent.indexAt("after"),
      };
    });
  }

  /**
   * Opens a target Workspace only for the duration of one Organizer read.
   *
   * `WorkspaceDBTable.isLoading$` starts at `false`, before the first storage
   * state arrives, so waiting for `!isLoading` can observe an empty table.
   * Ready proves local materialization. Before reading a placement, wait for
   * remote acknowledgement and its queued frontend application as well.
   */
  private async withTargetOrganizer<T>(
    targetWorkspaceId: string,
    read: (organize: OrganizeService) => T | Promise<T>,
  ): Promise<T> {
    this.assertSameServerTarget(targetWorkspaceId);
    const opened = this.workspacesService.openByWorkspaceId(targetWorkspaceId);
    if (!opened) {
      throw new Error("Workspace content target is unavailable");
    }
    try {
      // Resolving OrganizeService connects the table document before waiting.
      const organize = opened.workspace.scope.get(OrganizeService);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TARGET_ORGANIZER_TIMEOUT_MS,
      );
      try {
        await opened.workspace.engine.doc.waitForDocReady(
          TARGET_ORGANIZER_DOC_ID,
          controller.signal,
        );
        await opened.workspace.engine.doc.waitForSynced(
          TARGET_ORGANIZER_DOC_ID,
          controller.signal,
        );
        await opened.workspace.engine.doc.waitForUpdated(
          TARGET_ORGANIZER_DOC_ID,
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
      return await read(organize);
    } finally {
      opened.dispose();
    }
  }

  private async assertFreshCapability(kind: WorkspaceContentOperationKindType) {
    await this.refreshAvailability(true);
    if (!this.canStart(kind)) {
      throw new Error("Workspace content operation is unavailable");
    }
  }

  private assertSameServerTarget(targetWorkspaceId: string) {
    if (
      !this.sameServerTargets().some(
        (workspace) => workspace.id === targetWorkspaceId,
      )
    ) {
      throw new Error("Workspace content target is outside this server");
    }
  }

  private sameServerTargets() {
    const source = this.workspaceService.workspace.meta;
    return this.workspacesService.list.workspaces$.value
      .filter(
        (workspace) =>
          workspace.id !== source.id &&
          workspace.flavour === source.flavour &&
          workspace.flavour !== "local",
      )
      .sort((left, right) =>
        (left.name ?? left.id).localeCompare(right.name ?? right.id),
      );
  }

  private requireServer() {
    const server = this.workspaceServerService.server;
    if (
      !server ||
      this.workspaceService.workspace.flavour === "local" ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    ) {
      this.invalidate();
      throw new Error("Workspace content operation requires an online server");
    }
    return server;
  }

  private invalidate() {
    this.clearStaleTimer();
    this.availability$.next({
      status: "unavailable",
      targets: this.sameServerTargets(),
    });
  }

  private scheduleExpiry() {
    this.clearStaleTimer();
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      const current = this.availability$.value;
      this.availability$.next({
        status: "checking",
        targets: this.sameServerTargets(),
        gitConfigured:
          current.status !== "unavailable" ? current.gitConfigured : undefined,
      });
      void this.refreshAvailability(true);
    }, CAPABILITY_TTL_MS);
  }

  private clearStaleTimer() {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }
}
