// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Framework } from "@myoxus/infra";

import { DocumentLifecycleStore } from "../doc/stores/document-lifecycle";
import { GuardService } from "../permissions/services/guard";
import { WorkspaceServerService } from "../server/services/workspace-server";
import { TagStore } from "../tag/stores/tag";
import { WorkspaceScope } from "../workspace/scopes/workspace";
import { WorkspaceService } from "../workspace/services/workspace";
import {
  DocumentMetadataCacheService,
  DocumentMetadataCacheStore,
} from "./services/document-metadata-cache";

// Registration is UI-free. One cache per workspace shares reads across routes;
// workspace disposal releases its models, subscriptions and pending generations.
export function configureDocumentMetadataModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .store(DocumentMetadataCacheStore)
    .service(DocumentMetadataCacheService, [
      DocumentMetadataCacheStore,
      WorkspaceServerService,
      WorkspaceService,
      DocumentLifecycleStore,
      GuardService,
      TagStore,
    ]);
}
