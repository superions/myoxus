import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import { getWorkspaceInfoQuery, leaveWorkspaceMutation } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { WorkspaceLocalState } from "../../workspace";

export class WorkspacePermissionStore extends Store {
  constructor(
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly workspaceLocalState: WorkspaceLocalState,
  ) {
    super();
  }

  async fetchWorkspaceInfo(workspaceId: string, signal?: AbortSignal) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const info = await this.workspaceServerService.server.gql({
      query: getWorkspaceInfoQuery,
      variables: {
        workspaceId,
      },
      context: { signal },
    });

    return info;
  }

  /**
   * @param workspaceName for send email
   */
  async leaveWorkspace(workspaceId: string) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    await this.workspaceServerService.server.gql({
      query: leaveWorkspaceMutation,
      variables: {
        workspaceId,
      },
    });
  }

  watchWorkspacePermissionCache() {
    return this.workspaceLocalState.watch<{
      isOwner: boolean;
      isAdmin: boolean;
      isShared: boolean;
    }>("permission");
  }

  setWorkspacePermissionCache(permission: {
    isOwner: boolean;
    isAdmin: boolean;
    isShared: boolean;
  }) {
    this.workspaceLocalState.set("permission", permission);
  }
}
