export { WorkspaceQuotaService } from "./services/quota";
export { QuotaCheck } from "./views/quota-check";
export { QuotaUploadWatcher } from "./views/quota-upload-watcher";

import { type Framework } from "@myoxus/infra";

import { WorkspaceServerService } from "../server";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { WorkspaceQuota } from "./entities/quota";
import { WorkspaceQuotaService } from "./services/quota";
import { WorkspaceQuotaStore } from "./stores/quota";

export function configureQuotaModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(WorkspaceQuotaService)
    .store(WorkspaceQuotaStore, [WorkspaceServerService])
    .entity(WorkspaceQuota, [WorkspaceService, WorkspaceQuotaStore]);
}
