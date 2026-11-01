// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  WorkbenchToolId,
  WorkbenchToolLayout,
  WorkbenchViewFamily,
} from "../../server/stores/user-preferences";

export interface ResolvedWorkbenchToolLayout {
  readonly orderedToolIds: readonly WorkbenchToolId[];
  readonly visibleToolIds: readonly WorkbenchToolId[];
  readonly collapsedToolIds: readonly WorkbenchToolId[];
}

const defaultVisibleTools: Record<
  WorkbenchViewFamily,
  readonly WorkbenchToolId[]
> = {
  "document-page": ["outline", "tags"],
  "document-edgeless": ["frame"],
  journal: ["calendar"],
  database: ["database-settings"],
  graph: ["graph-details"],
};

const unique = <T>(values: readonly T[]) => [...new Set(values)];

export const workbenchToolIds = [
  "outline",
  "tags",
  "frame",
  "document-info",
  "calendar",
  "agenda",
  "activity",
  "comment",
  "chat",
  "export",
  "analytics",
  "database-settings",
  "task-details",
  "graph-details",
] as const satisfies readonly WorkbenchToolId[];

export function isWorkbenchToolId(value: string): value is WorkbenchToolId {
  return workbenchToolIds.some((id) => id === value);
}

/**
 * Materialize the server-owned override against capabilities registered by the
 * current route. Missing overrides use product defaults; an explicit empty
 * visible list remains empty. Unknown persisted IDs stay ordered so a
 * temporarily unavailable capability does not destroy a user's layout.
 */
export function resolveWorkbenchToolLayout({
  viewFamily,
  registeredToolIds,
  override,
}: {
  viewFamily: WorkbenchViewFamily;
  registeredToolIds: readonly WorkbenchToolId[];
  override: WorkbenchToolLayout | null;
}): ResolvedWorkbenchToolLayout {
  const registered = unique(registeredToolIds);
  const orderedToolIds = unique([
    ...(override?.orderedToolIds ?? []),
    ...registered,
  ]);
  const orderedSet = new Set(orderedToolIds);
  const visibleToolIds = unique(
    (override?.visibleToolIds ?? defaultVisibleTools[viewFamily]).filter((id) =>
      orderedSet.has(id),
    ),
  );
  const visibleSet = new Set(visibleToolIds);
  const collapsedToolIds = unique(
    (override?.collapsedToolIds ?? []).filter((id) => visibleSet.has(id)),
  );

  return { orderedToolIds, visibleToolIds, collapsedToolIds };
}

export function moveVisibleTool(
  layout: ResolvedWorkbenchToolLayout,
  toolId: WorkbenchToolId,
  targetIndex: number,
): ResolvedWorkbenchToolLayout {
  const visible = [...layout.visibleToolIds];
  const fromIndex = visible.indexOf(toolId);
  if (fromIndex < 0) return layout;

  visible.splice(fromIndex, 1);
  const destination = Math.max(0, Math.min(targetIndex, visible.length));
  if (destination === fromIndex) return layout;
  visible.splice(destination, 0, toolId);

  const visibleSet = new Set(visible);
  let visibleIndex = 0;
  const ordered = layout.orderedToolIds.map((id) =>
    visibleSet.has(id) ? visible[visibleIndex++] : id,
  );

  return { ...layout, orderedToolIds: ordered, visibleToolIds: visible };
}
