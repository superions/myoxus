// SPDX-License-Identifier: MIT

import type { Framework } from "@myoxus/infra";

import { WorkspaceServerService } from "../server";
import {
  WorkspaceScope,
  WorkspaceService,
  WorkspacesService,
} from "../workspace";
import { WorkspaceContentOperationService } from "./service";

export {
  clearWorkspaceContentOperationFromLocation,
  projectWorkspaceContentOperationToLocation,
  workspaceContentOperationFromLocation,
} from "./location";
export { WorkspaceContentOperationService } from "./service";
export type {
  WorkspaceContentOperationDialogProps,
  WorkspaceContentOperationSelection,
} from "./types";

export function configureWorkspaceContentOperationModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(WorkspaceContentOperationService, [
      WorkspaceService,
      WorkspaceServerService,
      WorkspacesService,
    ]);
}
