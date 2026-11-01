import type { HelperClientEvents } from "@myoxus/desktop-api-contract";

import {
  deleteBackupWorkspace,
  deleteWorkspace,
  getDeletedWorkspaces,
  listLocalWorkspaceIds,
  trashWorkspace,
} from "./handlers";

export * from "./handlers";
export * from "./subjects";

export const workspaceEvents = {} satisfies HelperClientEvents["workspace"];

export const workspaceHandlers = {
  delete: deleteWorkspace,
  moveToTrash: trashWorkspace,
  getBackupWorkspaces: async () => {
    return getDeletedWorkspaces();
  },
  deleteBackupWorkspace: async (id: string) => deleteBackupWorkspace(id),
  listLocalWorkspaceIds: async () => listLocalWorkspaceIds(),
};
