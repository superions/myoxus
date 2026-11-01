export { DocsSearchService } from "./services/docs-search";

import { type Framework } from "@myoxus/infra";

import { DocsService } from "../doc";
import { WorkspaceServerService } from "../server";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { DocsSearchService } from "./services/docs-search";

export function configureDocsSearchModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(DocsSearchService, [
      WorkspaceService,
      WorkspaceServerService,
      DocsService,
    ]);
}
