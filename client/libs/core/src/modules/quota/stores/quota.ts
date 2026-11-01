import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import { workspaceQuotaQuery } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

export class WorkspaceQuotaStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async fetchWorkspaceQuota(workspaceId: string, signal?: AbortSignal) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const data = await this.workspaceServerService.server.gql({
      query: workspaceQuotaQuery,
      variables: {
        id: workspaceId,
      },
      context: {
        signal,
      },
    });
    if (!data.workspace) {
      throw new Error("Workspace quota not found");
    }
    return data.workspace.quota;
  }
}
