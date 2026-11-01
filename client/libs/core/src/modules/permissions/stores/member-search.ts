import { getMembersByWorkspaceIdQuery } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";

export class MemberSearchStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async getMembersByEmailOrName(
    workspaceId: string,
    query?: string,
    skip?: number,
    take?: number,
    signal?: AbortSignal,
  ) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const data = await this.workspaceServerService.server.gql({
      query: getMembersByWorkspaceIdQuery,
      variables: {
        workspaceId,
        skip,
        take,
        query,
      },
      context: {
        signal,
      },
    });

    return data.workspace;
  }
}
