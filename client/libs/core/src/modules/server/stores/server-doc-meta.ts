import { getWorkspacePageMetaByIdQuery } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import { type ServerDocMetaType } from "../entities/server-doc-meta";
import type { WorkspaceServerService } from "../services/workspace-server";

export class ServerDocMetaStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async fetchServerDocMeta(
    workspaceId: string,
    docId: string,
    abortSignal?: AbortSignal,
  ): Promise<ServerDocMetaType> {
    if (!this.workspaceServerService.server) {
      throw new Error("Server not found");
    }
    const serverConfigData = await this.workspaceServerService.server.gql({
      query: getWorkspacePageMetaByIdQuery,
      variables: { id: workspaceId, pageId: docId },
      context: {
        signal: abortSignal,
      },
    });
    if (!serverConfigData.workspace) {
      throw new Error("Workspace page meta not found");
    }
    return serverConfigData.workspace.pageMeta;
  }
}
