import {
  getWorkspacePageByIdQuery,
  type PublicDocMode,
  publishPageMutation,
  revokePublicPageMutation,
} from "@myoxus/graphql";

import type { WorkspaceServerService } from "../../server";

function requireWorkspaceServer(
  workspaceServerService: WorkspaceServerService,
) {
  const { server } = workspaceServerService;
  if (!server) {
    throw new Error("No Server");
  }
  return server;
}

export async function getShareInfoByDocId(
  workspaceServerService: WorkspaceServerService,
  workspaceId: string,
  docId: string,
  signal?: AbortSignal,
) {
  const server = requireWorkspaceServer(workspaceServerService);
  const data = await server.gql({
    query: getWorkspacePageByIdQuery,
    variables: {
      pageId: docId,
      workspaceId,
    },
    context: {
      signal,
    },
  });
  return data.workspace?.doc ?? undefined;
}

export async function enableSharePage(
  workspaceServerService: WorkspaceServerService,
  workspaceId: string,
  pageId: string,
  docMode?: PublicDocMode,
  signal?: AbortSignal,
) {
  const server = requireWorkspaceServer(workspaceServerService);
  await server.gql({
    query: publishPageMutation,
    variables: {
      pageId,
      workspaceId,
      mode: docMode,
    },
    context: {
      signal,
    },
  });
}

export async function disableSharePage(
  workspaceServerService: WorkspaceServerService,
  workspaceId: string,
  pageId: string,
  signal?: AbortSignal,
) {
  const server = requireWorkspaceServer(workspaceServerService);
  await server.gql({
    query: revokePublicPageMutation,
    variables: {
      pageId,
      workspaceId,
    },
    context: {
      signal,
    },
  });
}
