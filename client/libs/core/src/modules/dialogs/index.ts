import type { Framework } from "@myoxus/infra";

import { WorkspaceScope } from "../workspace";
import { GlobalDialogService } from "./services/dialog";
import { WorkspaceDialogService } from "./services/workspace-dialog";

export type { GLOBAL_DIALOG_SCHEMA, WORKSPACE_DIALOG_SCHEMA } from "./constant";
export { GlobalDialogService } from "./services/dialog";
export { WorkspaceDialogService } from "./services/workspace-dialog";
export type { DialogComponentProps } from "./types";

export function configureDialogModule(framework: Framework) {
  // Global dialogs are rendered once above route-specific server/workspace
  // scopes. Reusing one instance prevents an opener in a child scope from
  // publishing into a dialog list that the global host cannot observe.
  let globalDialogService: GlobalDialogService | undefined;
  framework
    .service(
      GlobalDialogService,
      () => (globalDialogService ??= new GlobalDialogService()),
    )
    .scope(WorkspaceScope)
    .service(WorkspaceDialogService);
}
