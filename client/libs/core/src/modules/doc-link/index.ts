import { type Framework } from "@myoxus/infra";

import { DocScope } from "../doc/scopes/doc";
import { DocService } from "../doc/services/doc";
import { DocsService } from "../doc/services/docs";
import { DocumentLifecycleStore } from "../doc/stores/document-lifecycle";
import { DocsSearchService } from "../docs-search";
import { FeatureFlagService } from "../feature-flag";
import { GuardService } from "../permissions";
import { DefaultServerService, WorkspaceServerService } from "../server";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { DocBacklinks } from "./entities/doc-backlinks";
import { DocLinks } from "./entities/doc-links";
import { DocLinksService } from "./services/doc-links";
import { OutgoingNavigationService } from "./services/outgoing-navigation";

export type { Backlink } from "./entities/doc-backlinks";
export type { Link } from "./entities/doc-links";
export { DocLinksService } from "./services/doc-links";
export {
  OutgoingNavigationService,
  navigationTargets,
} from "./services/outgoing-navigation";

export function configureDocLinksModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(OutgoingNavigationService, [
      WorkspaceService,
      WorkspaceServerService,
      DocumentLifecycleStore,
      GuardService,
    ])
    .scope(DocScope)
    .service(DocLinksService)
    .entity(DocBacklinks, [
      DocsSearchService,
      DocService,
      DocsService,
      FeatureFlagService,
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
      DocumentLifecycleStore,
    ])
    .entity(DocLinks, [
      DocsSearchService,
      DocService,
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
      DocumentLifecycleStore,
    ]);
}
