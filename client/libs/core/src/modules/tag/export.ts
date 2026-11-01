import type { WorkspaceLabelExport } from "@myoxus/desktop-api-contract";
import { exportWorkspaceTagsQuery } from "@myoxus/graphql";
import { GraphQLService, WorkspaceServerService } from "../server";
import type { Workspace } from "../workspace";

/** Remote exports never fall back to live Yjs labels on an API failure. */
export async function exportWorkspaceLabels(
  workspace: Workspace,
  externalIds: string[],
): Promise<WorkspaceLabelExport | undefined> {
  if (workspace.flavour === "local") return undefined;
  const server = workspace.scope.get(WorkspaceServerService).server;
  if (!server) throw new Error("Workspace server is unavailable for export");
  const response = await server.scope.get(GraphQLService).gql({
    query: exportWorkspaceTagsQuery,
    variables: { workspaceId: workspace.id, externalIds },
  });
  const projection = response.workspace?.exportWorkspaceTags as
    WorkspaceLabelExport | undefined;
  if (!projection)
    throw new Error("Workspace labels are unavailable for export");
  return projection;
}
