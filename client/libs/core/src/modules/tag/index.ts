export {
  type WorkspaceTagAssignmentCommit,
  WorkspaceTagAssignmentController,
  type WorkspaceTagAssignmentState,
} from "./assignment-controller";
export {
  isWorkspaceTagColorRole,
  WORKSPACE_TAG_COLOR_ROLES,
  workspaceTagColorRoleOrGrey,
} from "./color-role";
export { Tag } from "./entities/tag";
export { TagService } from "./service/tag";
export type { TagCatalogState } from "./stores/tag";
export { useArchiveTagConfirmModal } from "./view/archive-tag-modal";

import { type Framework } from "@myoxus/infra";

import { DocsService } from "../doc";
import { WorkspaceServerService } from "../server";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { Tag } from "./entities/tag";
import { TagList } from "./entities/tag-list";
import { TagService } from "./service/tag";
import { TagStore } from "./stores/tag";

export function configureTagModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(TagService)
    .store(TagStore, [WorkspaceService, WorkspaceServerService])
    .entity(TagList, [TagStore, DocsService])
    .entity(Tag, [TagStore, DocsService]);
}
