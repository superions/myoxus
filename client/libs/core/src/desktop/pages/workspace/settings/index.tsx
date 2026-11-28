// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type {
  UserSettingTab,
  WorkspaceSettingTab,
} from "@myoxus/core/modules/dialogs/constant";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useService } from "@myoxus/infra";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

export function Component() {
  const workbench = useService(WorkbenchService).workbench;
  const workspaceDialogService = useService(WorkspaceDialogService);
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? undefined;
  const openedRef = useRef(false);

  useEffect(() => {
    if (openedRef.current) {
      return;
    }
    openedRef.current = true;
    workbench.openAll();
    if (tab?.startsWith("workspace:")) {
      workspaceDialogService.open("workspace-settings", {
        activeTab: tab as WorkspaceSettingTab,
      });
    } else {
      workspaceDialogService.open("user-settings", {
        activeTab: tab as UserSettingTab | undefined,
      });
    }
  }, [tab, workbench, workspaceDialogService]);

  return null;
}
