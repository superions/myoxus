import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { BpmnEditorService } from "../bpmn-editor/session";
import { DocsService } from "../doc";
import { GuardService } from "../permissions";
import { WorkspaceDialogService } from "../dialogs";

export type { WorkspaceProfileInfo } from "./entities/profile";
export { Workspace } from "./entities/workspace";
export { WorkspaceEngineBeforeStart, WorkspaceInitialized } from "./events";
export { getMyoxusWorkspaceSchema } from "./global-schema";
export { canUseLocalWorkspaces } from "./local-workspace-capability";
export type { WorkspaceMetadata } from "./metadata";
export type { WorkspaceOpenOptions } from "./open-options";
export type { WorkspaceFlavourProvider } from "./providers/flavour";
export { WorkspaceFlavoursProvider } from "./providers/flavour";
export { WorkspaceLocalCache, WorkspaceLocalState } from "./providers/storage";
export { WorkspaceScope } from "./scopes/workspace";
export { WorkspaceListService } from "./services/list";
export { WorkspaceService } from "./services/workspace";
export { WorkspacesService } from "./services/workspaces";

import type { Framework } from "@myoxus/infra";

import { DocumentLifecycleStore } from "../doc/stores/document-lifecycle";
import { GlobalCache, GlobalState, StoreService } from "../storage";
import { WorkspaceEngine } from "./entities/engine";
import { WorkspaceList } from "./entities/list";
import { WorkspaceProfile } from "./entities/profile";
import { Workspace } from "./entities/workspace";
import {
  WorkspaceLocalCacheImpl,
  WorkspaceLocalStateImpl,
} from "./impls/storage";
import { WorkspaceFlavoursProvider } from "./providers/flavour";
import { WorkspaceLocalCache, WorkspaceLocalState } from "./providers/storage";
import { WorkspaceScope } from "./scopes/workspace";
import { WorkspaceDestroyService } from "./services/destroy";
import { WorkspaceEngineService } from "./services/engine";
import { WorkspaceFactoryService } from "./services/factory";
import { WorkspaceFlavoursService } from "./services/flavours";
import { WorkspaceListService } from "./services/list";
import { WorkspaceProfileService } from "./services/profile";
import { WorkspaceRepositoryService } from "./services/repo";
import { WorkspaceTransformService } from "./services/transform";
import { WorkspaceService } from "./services/workspace";
import { WorkspacesService } from "./services/workspaces";
import { WorkspaceProfileCacheStore } from "./stores/profile-cache";

export function configureWorkspaceModule(framework: Framework) {
  framework
    .service(WorkspacesService, [
      WorkspaceFlavoursService,
      WorkspaceListService,
      WorkspaceProfileService,
      WorkspaceTransformService,
      WorkspaceRepositoryService,
      WorkspaceFactoryService,
      WorkspaceDestroyService,
    ])
    .service(WorkspaceFlavoursService, [[WorkspaceFlavoursProvider]])
    .service(WorkspaceDestroyService, [WorkspaceFlavoursService])
    .service(WorkspaceListService)
    .entity(WorkspaceList, [WorkspaceFlavoursService])
    .service(WorkspaceProfileService)
    .store(WorkspaceProfileCacheStore, [GlobalCache])
    .entity(WorkspaceProfile, [
      WorkspaceProfileCacheStore,
      WorkspaceFlavoursService,
    ])
    .service(WorkspaceFactoryService, [WorkspaceFlavoursService])
    .service(WorkspaceTransformService, [
      WorkspaceFactoryService,
      WorkspaceDestroyService,
    ])
    .service(WorkspaceRepositoryService, [
      WorkspaceFlavoursService,
      WorkspaceProfileService,
      WorkspaceListService,
    ])
    .scope(WorkspaceScope)
    .service(WorkspaceService)
    .service(BpmnEditorService, [
      WorkspaceService,
      DocsService,
      GuardService,
      WorkspaceDialogService,
    ])
    .entity(Workspace, [
      WorkspaceScope,
      FeatureFlagService,
      WorkspaceListService,
    ])
    .service(WorkspaceEngineService, [WorkspaceScope])
    .entity(WorkspaceEngine, [
      WorkspaceService,
      StoreService,
      FeatureFlagService,
      DocumentLifecycleStore,
    ])
    .impl(WorkspaceLocalState, WorkspaceLocalStateImpl, [
      WorkspaceService,
      GlobalState,
    ])
    .impl(WorkspaceLocalCache, WorkspaceLocalCacheImpl, [
      WorkspaceService,
      GlobalCache,
    ]);
}
