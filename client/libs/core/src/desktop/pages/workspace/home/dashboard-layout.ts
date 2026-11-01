// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  WorkspaceDashboardDashletId,
  WorkspaceDashboardDashletSize,
  WorkspaceDashboardLayout,
} from "@myoxus/core/modules/server";

export const DASHBOARD_DASHLET_IDS = [
  "today",
  "tasks",
  "new-documents",
  "reminders",
  "recently-edited",
  "activity",
] as const satisfies readonly WorkspaceDashboardDashletId[];

export const DASHBOARD_DEFAULT_SIZES = {
  today: "wide",
  tasks: "standard",
  "new-documents": "standard",
  reminders: "standard",
  "recently-edited": "standard",
  activity: "standard",
} as const satisfies Record<
  WorkspaceDashboardDashletId,
  WorkspaceDashboardDashletSize
>;

export const DASHBOARD_COMPACT_DASHLET_IDS = [
  "new-documents",
  "recently-edited",
] as const satisfies readonly WorkspaceDashboardDashletId[];

export const DASHBOARD_DOCUMENT_LIMITS = {
  compact: 3,
  standard: 4,
  wide: 6,
} as const satisfies Record<WorkspaceDashboardDashletSize, number>;

export interface ResolvedWorkspaceDashboardLayout {
  readonly orderedDashletIds: readonly WorkspaceDashboardDashletId[];
  readonly dashletSizes: Readonly<
    Record<WorkspaceDashboardDashletId, WorkspaceDashboardDashletSize>
  >;
}

/** Resolve an optional override without materializing defaults on read. */
export function resolveWorkspaceDashboardLayout(
  override: WorkspaceDashboardLayout | null,
): ResolvedWorkspaceDashboardLayout {
  const known = new Set<WorkspaceDashboardDashletId>();
  // Existing partial overrides first retain their previously resolved five
  // sections; the new Task section appends unless explicitly ordered by a user.
  const defaults = override
    ? [
        ...DASHBOARD_DASHLET_IDS.filter((id) => id !== "tasks"),
        "tasks" as const,
      ]
    : DASHBOARD_DASHLET_IDS;
  const orderedDashletIds = [
    ...(override?.orderedDashletIds ?? []),
    ...defaults,
  ].filter((id): id is WorkspaceDashboardDashletId => {
    if (!DASHBOARD_DASHLET_IDS.includes(id) || known.has(id)) return false;
    known.add(id);
    return true;
  });
  return {
    orderedDashletIds,
    dashletSizes: {
      ...DASHBOARD_DEFAULT_SIZES,
      ...override?.dashletSizes,
    },
  };
}

export function moveDashboardDashlet(
  layout: ResolvedWorkspaceDashboardLayout,
  dashletId: WorkspaceDashboardDashletId,
  targetIndex: number,
): ResolvedWorkspaceDashboardLayout {
  const currentIndex = layout.orderedDashletIds.indexOf(dashletId);
  if (currentIndex < 0) return layout;
  const orderedDashletIds = [...layout.orderedDashletIds];
  orderedDashletIds.splice(currentIndex, 1);
  orderedDashletIds.splice(
    Math.max(0, Math.min(targetIndex, orderedDashletIds.length)),
    0,
    dashletId,
  );
  return { ...layout, orderedDashletIds };
}

export function resizeDashboardDashlet(
  layout: ResolvedWorkspaceDashboardLayout,
  dashletId: WorkspaceDashboardDashletId,
  size: WorkspaceDashboardDashletSize,
): ResolvedWorkspaceDashboardLayout {
  if (
    size === "compact" &&
    !DASHBOARD_COMPACT_DASHLET_IDS.includes(
      dashletId as (typeof DASHBOARD_COMPACT_DASHLET_IDS)[number],
    )
  ) {
    return layout;
  }
  return {
    ...layout,
    dashletSizes: { ...layout.dashletSizes, [dashletId]: size },
  };
}

/** Keep dashboard preview density aligned with the semantic desktop size. */
export function getDashboardDocumentLimit(size: WorkspaceDashboardDashletSize) {
  return DASHBOARD_DOCUMENT_LIMITS[size];
}

export function toWorkspaceDashboardLayout(
  workspaceId: string,
  layout: ResolvedWorkspaceDashboardLayout,
): WorkspaceDashboardLayout {
  return {
    workspaceId,
    orderedDashletIds: [...layout.orderedDashletIds],
    dashletSizes: { ...layout.dashletSizes },
  };
}
