// SPDX-License-Identifier: AGPL-3.0-or-later

import { useService } from "@myoxus/infra";
import {
  type ComponentProps,
  forwardRef,
  useImperativeHandle,
  useState,
} from "react";

import { ViewService } from "../../workbench/services/view";
import { WorkbenchToolLayoutBinding } from "../../workbench/view/tool-layout-binding";
import {
  DATABASE_WORKBENCH_CONTEXT_SURFACE_ID,
  type DatabaseWorkbenchContextSection,
  DatabaseWorkbenchContext,
  DatabaseWorkbenchContextSurface,
} from "./database-workbench-context";

export type DatabasePageWorkbenchContextHandle = {
  open: (section: DatabaseWorkbenchContextSection) => void;
  close: () => void;
};

/**
 * Isolates page-only Workbench services from the editor embed. The embed keeps
 * the shared Database host and its Modal controls without requiring a route
 * View scope, while the page registers and opens the canonical Context Card.
 */
export const DatabasePageWorkbenchContextBridge = forwardRef<
  DatabasePageWorkbenchContextHandle,
  Omit<ComponentProps<typeof DatabaseWorkbenchContext>, "requestedSection">
>(function DatabasePageWorkbenchContextBridge(surfaceProps, ref) {
  const workbenchView = useService(ViewService).view;
  const { onEditScopeChange } = surfaceProps;
  const { canEditShared } = surfaceProps.effectiveState;
  const [contextSection, setContextSection] =
    useState<DatabaseWorkbenchContextSection>("fields");
  useImperativeHandle(
    ref,
    () => ({
      close() {
        workbenchView.hideTool(DATABASE_WORKBENCH_CONTEXT_SURFACE_ID);
      },
      open(section) {
        setContextSection(section);
        if (section !== "assistance") {
          onEditScopeChange(canEditShared ? "shared" : "personal");
        }
        workbenchView.showTool(DATABASE_WORKBENCH_CONTEXT_SURFACE_ID);
      },
    }),
    [canEditShared, onEditScopeChange, workbenchView],
  );

  return (
    <>
      <WorkbenchToolLayoutBinding
        workspaceId={surfaceProps.workspaceId}
        viewFamily="database"
      />
      <DatabaseWorkbenchContextSurface
        {...surfaceProps}
        requestedSection={contextSection}
      />
    </>
  );
});
