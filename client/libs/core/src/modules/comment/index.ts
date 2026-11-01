import type { Framework } from "@myoxus/infra";

import { DocumentLifecycleStore } from "../doc/stores/document-lifecycle";
import { DocDisplayMetaService } from "../doc-display-meta";
import { DefaultServerService, WorkspaceServerService } from "../server";
import { WorkbenchService } from "../workbench";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { DocCommentEntity } from "./entities/doc-comment";
import { DocCommentStore } from "./entities/doc-comment-store";
import { CommentPanelService } from "./services/comment-panel-service";
import { DocCommentManagerService } from "./services/doc-comment-manager";
import { SnapshotHelper } from "./services/snapshot-helper";

export function configureCommentModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(DocCommentManagerService)
    .service(CommentPanelService, [WorkbenchService])
    .service(SnapshotHelper, [
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
    ])
    .entity(DocCommentEntity, [
      SnapshotHelper,
      DocDisplayMetaService,
      DocumentLifecycleStore,
    ])
    .entity(DocCommentStore, [
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
    ]);
}
