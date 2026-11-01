import { type Framework } from "@myoxus/infra";

import { DesktopApiService } from "../desktop-api";
import { WorkspacesService } from "../workspace";
import { BackupService } from "./services";

export function configureDesktopBackupModule(framework: Framework) {
  framework.service(BackupService, [DesktopApiService, WorkspacesService]);
}
