// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Framework } from "@myoxus/infra";

import { WorkspaceServerService } from "../server";
import { WorkspaceScope, WorkspaceService } from "../workspace";
import { DatabasePagesService } from "./database-pages-service";

export * from "./cleanup";
export * from "./database-page-menu";
export * from "./database-pages";
export * from "./identity";
export * from "./move-dialog";
export * from "./organizer";
export * from "./projection";
export * from "./use-database-page";
export * from "./use-database-page-actions";

export function configureWorkspacePagesModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(DatabasePagesService, [WorkspaceService, WorkspaceServerService]);
}
