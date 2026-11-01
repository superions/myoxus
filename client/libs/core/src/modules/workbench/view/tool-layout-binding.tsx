// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useUserPreferencesService } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { WorkbenchViewFamily } from "@myoxus/core/modules/server/services/user-preferences";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

import { ViewService } from "../services/view";
import { WorkbenchService } from "../services/workbench";

/** Bind one route-owned view family to the account preference projection. */
export function WorkbenchToolLayoutBinding({
  workspaceId,
  viewFamily,
}: {
  workspaceId: string;
  viewFamily: WorkbenchViewFamily;
}) {
  const preferences = useUserPreferencesService();
  const projection = useLiveData(preferences.workbenchToolLayouts$);
  const view = useService(ViewService).view;
  const workbench = useService(WorkbenchService).workbench;
  const override =
    projection.projected?.find(
      (layout) =>
        layout.workspaceId === workspaceId && layout.viewFamily === viewFamily,
    ) ?? null;

  useEffect(
    () =>
      view.bindToolLayout({
        workspaceId,
        viewFamily,
        override,
        persist: (layout) => void preferences.updateWorkbenchToolLayout(layout),
        openToolHost: () => workbench.openContextPanel(),
        closeToolHost: () => workbench.closeContextPanel(),
      }),
    [override, preferences, view, viewFamily, workbench, workspaceId],
  );

  return null;
}
