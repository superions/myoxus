import type { Framework } from "@myoxus/infra";

import { WorkspaceDialogService } from "../dialogs";
import { TemplateInputPromptService } from "./services/template-input-prompt";

import { WorkspaceDBService } from "../db";
import { DocsService } from "../doc";
import { GuardService } from "../permissions";
import { DefaultServerService, WorkspaceServerService } from "../server";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { WorkspacesService } from "../workspace";
import { FeatureFlagService } from "../feature-flag";
import { TemplateSectionInsertionService } from "./services/template-section-insertion";
import { WorkbenchService } from "../workbench/services/workbench";
import { TemplateCheckService } from "./services/template-check";
import { TemplateApplicationService } from "./services/template-application";
import { TemplateDocList } from "./entities/list";
import { TemplateDocSetting } from "./entities/setting";
import { BuiltinTemplateReconcilerService } from "./services/builtin-reconciler";
import { TemplateDocService } from "./services/template-doc";
import { TemplateInstantiationService } from "./services/template-instantiation";
import { TemplateDocListStore } from "./store/list";
import { TemplateDocSettingStore } from "./store/setting";

export type {
  BuiltinCategory,
  ResolvedTemplateSourceMetadata,
  TemplateTitlePolicy,
} from "./services/source-metadata";
export {
  type LoadTemplateSuggestionsOptions,
  type TemplateCategoryFilter,
  type TemplateSourceOrigin,
  TemplateSuggestionSurface,
} from "./services/template-doc";
export {
  BuiltinTemplateReconcilerService,
  TemplateDocService,
  TemplateInstantiationService,
  TemplateApplicationService,
  TemplateCheckService,
  TemplateSectionInsertionService,
};

export const configureTemplateDocModule = (framework: Framework) => {
  framework
    .scope(WorkspaceScope)
    .service(BuiltinTemplateReconcilerService, [
      DocsService,
      WorkspaceService,
      WorkspaceServerService,
    ])
    .service(TemplateDocService, [
      WorkspaceService,
      WorkspaceServerService,
      DefaultServerService,
      BuiltinTemplateReconcilerService,
    ])
    .service(TemplateCheckService, [DocsService, TemplateDocService])
    .service(TemplateInstantiationService, [DocsService, TemplateDocService])
    .service(TemplateSectionInsertionService, [
      DocsService,
      TemplateDocService,
      GuardService,
      WorkspaceService,
      FeatureFlagService,
      WorkspacesService,
    ])
    .service(TemplateInputPromptService, [WorkspaceDialogService])
    .service(TemplateApplicationService, [
      TemplateInstantiationService,
      WorkbenchService,
      TemplateInputPromptService,
    ])
    .store(TemplateDocListStore, [WorkspaceDBService, WorkspaceService])
    .entity(TemplateDocList, [TemplateDocListStore, DocsService])
    .store(TemplateDocSettingStore, [WorkspaceDBService])
    .entity(TemplateDocSetting, [TemplateDocSettingStore]);
};
