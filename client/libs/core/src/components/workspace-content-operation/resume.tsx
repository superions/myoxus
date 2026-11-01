// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { workspaceContentOperationFromLocation } from "@myoxus/core/modules/workspace-content-operation/location";
import { useService } from "@myoxus/infra";
import { useEffect, useRef } from "react";

/**
 * Reopens a durable server operation after a workspace-route reload.
 *
 * Only the operation identifier lives in the URL. Current status, permissions
 * and result metadata are resolved from the authoritative server projection.
 */
export function WorkspaceContentOperationResume() {
  const workspaceDialogService = useService(WorkspaceDialogService);
  const opened = useRef(false);

  useEffect(() => {
    const operationId = workspaceContentOperationFromLocation();
    if (!operationId || opened.current) return;

    opened.current = true;
    workspaceDialogService.open("workspace-content-operation", {
      resumeOperationId: operationId,
    });
  }, [workspaceDialogService]);

  return null;
}
