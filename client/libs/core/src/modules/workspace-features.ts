// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { configureQuotaModule } from "@myoxus/core/modules/quota";
import type { Framework } from "@myoxus/infra";

import {
  configureAIButtonModule,
  configureAIDraftModule,
  configureAIModelModule,
  configureAIPlaygroundModule,
  configureAIReasoningModule,
  configureAIToolsConfigModule,
} from "./ai-button";
import { configureAllDocsModule } from "./all-docs";
import { configureAppSidebarModule } from "./app-sidebar";
import { configAtMenuConfigModule } from "./at-menu-config";
import { configureBlobManagementModule } from "./blob-management";
import { configureCollectionModule } from "./collection";
import { configureCollectionRulesModule } from "./collection-rules";
import { configureCommentModule } from "./comment";
import { configureDndModule } from "./dnd";
import { configureDocDisplayMetaModule } from "./doc-display-meta";
import { configureDocLinksModule } from "./doc-link";
import { configureDocSummaryModule } from "./doc-summary";
import { configureDocsSearchModule } from "./docs-search";
import { configureDocumentMetadataModule } from "./document-metadata/module";
import { configureEditorModule } from "./editor";
import { configureEditorSettingModule } from "./editor-setting";
import { configureExplorerIconModule } from "./explorer-icon";
import { configureFavoriteModule } from "./favorite";
import { configureIconPickerModule } from "./icon-picker";
import { configureIntegrationModule } from "./integration";
import { configureJournalModule } from "./journal";
import { configureMediaModule } from "./media";
import { configureMermaidDiagramsModule } from "./mermaid-diagrams";
import { configureOrganizeModule } from "./organize";
import { configurePDFModule } from "./pdf";
import { configurePeekViewModule } from "./peek-view";
import { configurePermissionsModule } from "./permissions";
import { configureQuickSearchModule } from "./quicksearch";
import { configSearchMenuModule } from "./search-menu";
import { configureShareDocsModule } from "./share-doc";
import { configureShareSettingModule } from "./share-setting";
import { configureStructureTreeModule } from "./structure-tree";
import { configureTagModule } from "./tag";
import { configureTemplateDocModule } from "./template-doc";
import { configureWorkspaceContentOperationModule } from "./workspace-content-operation";
import { configureIndexerEmbeddingModule } from "./workspace-indexer-embedding";
import { configureWorkspacePropertyModule } from "./workspace-property";
import { configureWorkspacePagesModule } from "./workspace-pages";

/** Workspace-only services loaded before the desktop workspace route mounts. */
export function configureCommonWorkspaceFeatureModules(framework: Framework) {
  configureAllDocsModule(framework);
  configureCollectionModule(framework);
  configureQuotaModule(framework);
  configurePermissionsModule(framework);
  configureTagModule(framework);
  configureShareDocsModule(framework);
  configureShareSettingModule(framework);
  configurePDFModule(framework);
  configurePeekViewModule(framework);
  configureExplorerIconModule(framework);
  configureDocDisplayMetaModule(framework);
  configureQuickSearchModule(framework);
  configureDocsSearchModule(framework);
  configureDocLinksModule(framework);
  configureDocumentMetadataModule(framework);
  configureWorkspacePagesModule(framework);
  configureOrganizeModule(framework);
  configureFavoriteModule(framework);
  configureStructureTreeModule(framework);
  configureEditorModule(framework);
  configureEditorSettingModule(framework);
  configureAppSidebarModule(framework);
  configureJournalModule(framework);
  configureMermaidDiagramsModule(framework);
  configAtMenuConfigModule(framework);
  configSearchMenuModule(framework);
  configureDndModule(framework);
  configureAIReasoningModule(framework);
  configureAIPlaygroundModule(framework);
  configureAIButtonModule(framework);
  configureAIDraftModule(framework);
  configureAIToolsConfigModule(framework);
  configureAIModelModule(framework);
  configureTemplateDocModule(framework);
  configureBlobManagementModule(framework);
  configureMediaModule(framework);
  configureIntegrationModule(framework);
  configureWorkspacePropertyModule(framework);
  configureWorkspaceContentOperationModule(framework);
  configureCollectionRulesModule(framework);
  configureIndexerEmbeddingModule(framework);
  configureCommentModule(framework);
  configureDocSummaryModule(framework);
  configureIconPickerModule(framework);
}
