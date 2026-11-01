export interface WorkspaceMeta {
  id: string;
  mainDBPath: string;
}

export type YOrigin = "self" | "external" | "upstream" | "renderer";
