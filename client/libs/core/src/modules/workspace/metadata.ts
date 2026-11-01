import type {
  CreateWorkspaceMutation,
  WorkspaceInitialContentPolicy,
} from "@myoxus/graphql";

export const localWorkspaceInitialContentPolicyKey = (id: string) =>
  `workspace-engine:local-initial-content:${id}`;
export const localWorkspaceAssistanceKey = (id: string) =>
  `workspace-engine:local-assistance:${id}`;

export type WorkspaceMetadata = {
  id: string;
  flavour: string;
  initialized?: boolean;
  initialContentPolicy?: WorkspaceInitialContentPolicy;
  creation?: CreateWorkspaceMutation["createWorkspace"]["creation"];
  name?: string;
  role?:
    | "Owner"
    | "Admin"
    | "Manager"
    | "Collaborator"
    | "Commenter"
    | "Reader"
    | "External";
  workspaceType?: "Personal" | "UserOwned" | "Shared";
  isOwner?: boolean;
  isAdmin?: boolean;
};
