export interface NodeInfo {
  id: string;
  parentId: string | null;
  type: "folder" | FolderLinkType;
  data: string;
  index: string;
  targetWorkspaceId?: string;
}

export type FolderLinkType =
  "collection" | "database" | "doc" | "tag" | "workspace";
