import type { WorkspaceServerService } from "@myoxus/core/modules/server";
import {
  getWorkspacePublicPagesQuery,
  type PublicDocMode,
} from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import { disableSharePage, enableSharePage } from "./public-share-api";

export class ShareDocsStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async getWorkspacesShareDocs(workspaceId: string, signal?: AbortSignal) {
    if (!this.workspaceServerService.server) {
      throw new Error("No Server");
    }
    const data = await this.workspaceServerService.server.gql({
      query: getWorkspacePublicPagesQuery,
      variables: {
        workspaceId: workspaceId,
      },
      context: {
        signal,
      },
    });
    if (!data.workspace) {
      throw new Error("Workspace public docs not found");
    }
    return data.workspace.publicDocs;
  }

  async enableSharePage(
    workspaceId: string,
    pageId: string,
    docMode?: PublicDocMode,
    signal?: AbortSignal,
  ) {
    await enableSharePage(
      this.workspaceServerService,
      workspaceId,
      pageId,
      docMode,
      signal,
    );
  }

  async disableSharePage(
    workspaceId: string,
    pageId: string,
    signal?: AbortSignal,
  ) {
    await disableSharePage(
      this.workspaceServerService,
      workspaceId,
      pageId,
      signal,
    );
  }
}
