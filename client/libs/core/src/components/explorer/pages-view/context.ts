import type {
  DatabasePageRecord,
  DatabasePagesLoadState,
  WorkspacePageGroup,
} from "@myoxus/core/modules/workspace-pages";
import { createContext } from "react";

export interface WorkspacePagesExplorerContextValue {
  databasePages: ReadonlyMap<string, DatabasePageRecord>;
  groups: readonly WorkspacePageGroup[];
  loadState: DatabasePagesLoadState;
  reload: () => void;
  retry: () => void;
  workspaceId: string;
}

export const WorkspacePagesExplorerContext =
  createContext<WorkspacePagesExplorerContextValue | null>(null);
