import type { Framework } from "@myoxus/infra";

import { FeatureFlagService } from "../feature-flag";
import { WorkspaceServerService } from "../server";
import { CacheStorage } from "../storage";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { DocSummaryService } from "./services/doc-summary";
import { DocSummaryStore } from "./stores/doc-summary";

export { DocSummaryService };

export function configureDocSummaryModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(DocSummaryService, [
      WorkspaceService,
      DocSummaryStore,
      FeatureFlagService,
      WorkspaceServerService,
    ])
    .store(DocSummaryStore, [
      WorkspaceService,
      WorkspaceServerService,
      CacheStorage,
    ]);
}
