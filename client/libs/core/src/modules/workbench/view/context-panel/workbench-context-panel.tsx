// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { WorkbenchContextPanelSurface } from "@myoxus/ui-facade";
import { type RefObject, useCallback } from "react";

import { ViewService } from "../../services/view";
import { WorkbenchService } from "../../services/workbench";
import { ContextSurfaceHost } from "./context-surface-host";

export function WorkbenchContextPanel({
  returnFocusRef,
}: {
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const opened = useLiveData(workbench.contextPanelOpen$);
  const contextSurfaces = useLiveData(view.contextSurfaces$);

  const handleOpenChange = useCallback(
    (nextOpened: boolean) => {
      workbench.setContextPanelOpen(nextOpened);
    },
    [workbench],
  );

  if (contextSurfaces.length === 0) return null;

  return (
    <WorkbenchContextPanelSurface
      closeButtonLabel={t["com.myoxus.peek-view-controls.close"]()}
      drawerTitle={t["com.myoxus.workbench.contextPanel.title"]()}
      opened={Boolean(opened)}
      onOpenChange={handleOpenChange}
      returnFocusRef={returnFocusRef}
      data-testid="workbench-context-panel"
    >
      <ContextSurfaceHost />
    </WorkbenchContextPanelSurface>
  );
}
