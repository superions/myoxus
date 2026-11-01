import { type Framework } from "@myoxus/infra";

import { CollectionService } from "../collection";
import { WorkspaceDialogService } from "../dialogs";
import { DocsService } from "../doc";
import { DocDisplayMetaService } from "../doc-display-meta";
import { DocsSearchService } from "../docs-search";
import { FavoriteService } from "../favorite";
import { GlobalContextService } from "../global-context";
import { JournalService } from "../journal";
import { WorkspaceServerService } from "../server";
import { TagService } from "../tag";
import { WorkbenchService } from "../workbench/services/workbench";
import {
  WorkspaceLocalState,
  WorkspaceScope,
  WorkspaceService,
} from "../workspace";
import { QuickSearch } from "./entities/quick-search";
import { CollectionsQuickSearchSession } from "./impls/collections";
import { CommandsQuickSearchSession } from "./impls/commands";
import { CreationQuickSearchSession } from "./impls/creation";
import { DatabaseRowsQuickSearchSession } from "./impls/database-rows";
import { DatabasesQuickSearchSession } from "./impls/databases";
import { DocsQuickSearchSession } from "./impls/docs";
import { ExternalLinksQuickSearchSession } from "./impls/external-links";
import { FavoritesQuickSearchSession } from "./impls/favorites";
import { JournalsQuickSearchSession } from "./impls/journals";
import { LinksQuickSearchSession } from "./impls/links";
import { RecentDocsQuickSearchSession } from "./impls/recent-docs";
import { RecentTargetsQuickSearchSession } from "./impls/recent-targets";
import { TagsQuickSearchSession } from "./impls/tags";
import { CMDKQuickSearchService } from "./services/cmdk";
import { QuickSearchService } from "./services/quick-search";
import { RecentWorkspaceItemsService } from "./services/recent-workspace-items";

export { QuickSearch } from "./entities/quick-search";
export { QuickSearchService, RecentWorkspaceItemsService };
export { CollectionsQuickSearchSession } from "./impls/collections";
export { CommandsQuickSearchSession } from "./impls/commands";
export { CreationQuickSearchSession } from "./impls/creation";
export { DatabaseRowsQuickSearchSession } from "./impls/database-rows";
export { DatabasesQuickSearchSession } from "./impls/databases";
export { DocsQuickSearchSession } from "./impls/docs";
export { ExternalLinksQuickSearchSession } from "./impls/external-links";
export { FavoritesQuickSearchSession } from "./impls/favorites";
export { LinksQuickSearchSession } from "./impls/links";
export { RecentDocsQuickSearchSession } from "./impls/recent-docs";
export { RecentTargetsQuickSearchSession } from "./impls/recent-targets";
export { TagsQuickSearchSession } from "./impls/tags";
export type { QuickSearchItem } from "./types/item";
export { QuickSearchContainer } from "./views/container";
export { QuickSearchTagIcon } from "./views/tag-icon";

export function configureQuickSearchModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(QuickSearchService)
    .service(CMDKQuickSearchService, [
      QuickSearchService,
      WorkbenchService,
      DocsService,
    ])
    .service(RecentWorkspaceItemsService, [WorkspaceLocalState, DocsService])
    .entity(QuickSearch)
    .entity(CommandsQuickSearchSession, [GlobalContextService])
    .entity(DocsQuickSearchSession, [
      WorkspaceService,
      DocsSearchService,
      DocsService,
      DocDisplayMetaService,
    ])
    .entity(LinksQuickSearchSession, [
      WorkspaceService,
      DocsService,
      DocDisplayMetaService,
    ])
    .entity(ExternalLinksQuickSearchSession, [WorkspaceService])
    .entity(CreationQuickSearchSession)
    .entity(CollectionsQuickSearchSession, [CollectionService])
    .entity(TagsQuickSearchSession, [TagService])
    .entity(RecentDocsQuickSearchSession, [
      RecentWorkspaceItemsService,
      DocDisplayMetaService,
    ])
    .entity(RecentTargetsQuickSearchSession, [
      RecentWorkspaceItemsService,
      DocsService,
      DocDisplayMetaService,
      WorkspaceService,
      WorkspaceServerService,
    ])
    .entity(FavoritesQuickSearchSession, [
      FavoriteService,
      DocsService,
      DocDisplayMetaService,
      CollectionService,
      TagService,
      WorkspaceService,
      WorkspaceServerService,
    ])
    .entity(DatabasesQuickSearchSession, [
      WorkspaceService,
      WorkspaceServerService,
    ])
    .entity(DatabaseRowsQuickSearchSession, [
      WorkspaceService,
      WorkspaceServerService,
    ])
    .entity(JournalsQuickSearchSession, [
      JournalService,
      WorkspaceDialogService,
      DocDisplayMetaService,
    ]);
}
