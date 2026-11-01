// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { ChartPanelIcon } from "@myoxus/icons/react";
import { Scrollable, WorkbenchContextScrollRoot } from "@myoxus/ui-facade";
import { lazy, Suspense } from "react";

const EditorAnalyticsPanel = lazy(() =>
  import("./panel").then((module) => ({
    default: module.EditorAnalyticsPanel,
  })),
);

const DOCUMENT_VIEW_FAMILIES = [
  "document-page",
  "document-edgeless",
  "journal",
] as const;

/**
 * Registers document analytics for every server-backed workspace. Local
 * workspaces have no authoritative server analytics and remain excluded.
 */
export function AnalyticsSidecard({
  docId,
  workspaceFlavour,
  workspaceId,
}: {
  docId: string;
  workspaceFlavour: string;
  workspaceId: string;
}) {
  const t = useI18n();

  if (workspaceFlavour === "local") {
    return null;
  }

  return (
    <ViewContextSurface
      surfaceId="analytics"
      order={90}
      label={t["com.myoxus.sidebar.tab.analytics"]()}
      tooltip={t["com.myoxus.sidebar.tab.analytics.tooltip"]()}
      icon={<ChartPanelIcon />}
      viewFamilies={DOCUMENT_VIEW_FAMILIES}
    >
      <WorkbenchContextScrollRoot>
        <Scrollable.Viewport>
          <Suspense>
            <EditorAnalyticsPanel workspaceId={workspaceId} docId={docId} />
          </Suspense>
        </Scrollable.Viewport>
        <Scrollable.Scrollbar />
      </WorkbenchContextScrollRoot>
    </ViewContextSurface>
  );
}
