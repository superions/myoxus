export { Doc } from "./entities/doc";
export { DocRecord } from "./entities/record";
export { DocRecordList } from "./entities/record-list";
export { isDocumentNotFoundError } from "./errors";
export { DocCreated } from "./events";
export { DocScope } from "./scopes/doc";
export { DocService } from "./services/doc";
export { DocsService, DocProvisioningError } from "./services/docs";
export { CoreDocEmbedProvider } from "./services/doc-embed";

import type { Framework } from "@myoxus/infra";

import { WorkspaceDBService } from "../db/services/db";
import { DocumentMetadataCacheService } from "../document-metadata/services/document-metadata-cache";
import { WorkspaceServerService } from "../server/services/workspace-server";
import { WorkspaceScope } from "../workspace/scopes/workspace";
import { WorkspaceService } from "../workspace/services/workspace";
import { TagStore } from "../tag/stores/tag";
import { Doc } from "./entities/doc";
import { DocRecord } from "./entities/record";
import { DocRecordList } from "./entities/record-list";
import { DocCreateMiddleware } from "./providers/doc-create-middleware";
import { DocScope } from "./scopes/doc";
import { DocService } from "./services/doc";
import { DocsService } from "./services/docs";
import { DocPropertiesStore } from "./stores/doc-properties";
import { DocsStore } from "./stores/docs";
import { DocumentLifecycleStore } from "./stores/document-lifecycle";

export { DocCreateMiddleware } from "./providers/doc-create-middleware";

export function configureDocModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(DocsService, [
      DocsStore,
      DocPropertiesStore,
      [DocCreateMiddleware],
    ])
    .store(DocPropertiesStore, [WorkspaceService, WorkspaceDBService])
    .store(DocumentLifecycleStore)
    .store(DocsStore, [
      WorkspaceService,
      WorkspaceServerService,
      DocPropertiesStore,
      DocumentMetadataCacheService,
      DocumentLifecycleStore,
    ])
    .entity(DocRecord, [DocsStore, DocPropertiesStore, TagStore])
    .entity(DocRecordList, [DocsStore])
    .scope(DocScope)
    .entity(Doc, [
      DocScope,
      DocsStore,
      WorkspaceService,
      DocumentMetadataCacheService,
    ])
    .service(DocService);
}
