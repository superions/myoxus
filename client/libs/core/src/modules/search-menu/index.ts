import { type Framework } from "@myoxus/infra";

import { CollectionService } from "../collection";
import { DocDisplayMetaService } from "../doc-display-meta";
import { DocsSearchService } from "../docs-search";
import { RecentWorkspaceItemsService } from "../quicksearch";
import { TagService } from "../tag";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { SearchMenuService } from "./services";

export function configSearchMenuModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(SearchMenuService, [
      WorkspaceService,
      DocDisplayMetaService,
      RecentWorkspaceItemsService,
      DocsSearchService,
      TagService,
      CollectionService,
    ]);
}
