import type { PublicDocMode } from "@myoxus/graphql";
import { Store } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";
import {
  disableSharePage,
  enableSharePage,
  getShareInfoByDocId,
} from "./public-share-api";

export class ShareStore extends Store {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
  }

  async getShareInfoByDocId(
    workspaceId: string,
    docId: string,
    signal?: AbortSignal,
  ) {
    return getShareInfoByDocId(
      this.workspaceServerService,
      workspaceId,
      docId,
      signal,
    );
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
