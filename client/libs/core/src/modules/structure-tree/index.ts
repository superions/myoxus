import { type Framework } from "@myoxus/infra";

import { GlobalCache } from "../storage";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { StructureTreeStateService } from "./services/structure-tree-state";
export { StructureTreeStateService } from "./services/structure-tree-state";

export function configureStructureTreeModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(StructureTreeStateService, [GlobalCache, WorkspaceService]);
}
