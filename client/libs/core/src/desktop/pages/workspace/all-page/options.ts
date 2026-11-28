// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  ExplorerDisplayPreference,
  ExplorerPreviewSize,
} from "@myoxus/core/components/explorer/types";
import { WorkspaceLocalState } from "@myoxus/core/modules/workspace";
import { useService } from "@myoxus/infra";
import { useCallback, useState } from "react";

export type AllDocsViewMode = NonNullable<ExplorerDisplayPreference["view"]>;

const BASE_DISPLAY_PROPERTIES = [
  "system:createdAt",
  "system:updatedAt",
  "system:createdBy",
  "system:tags",
];

const BASE_PREFERENCE: Omit<ExplorerDisplayPreference, "view" | "groupBy"> = {
  previewSize: "normal",
  displayProperties: BASE_DISPLAY_PROPERTIES,
  orderBy: {
    type: "system",
    key: "updatedAt",
    desc: true,
  },
  showDocIcon: true,
  showDocPreview: true,
  quickFavorite: true,
  showDragHandle: true,
  showMoreOperation: true,
};

export const DEFAULT_DISPLAY_PREFERENCES: Record<
  AllDocsViewMode,
  ExplorerDisplayPreference
> = {
  grid: { ...BASE_PREFERENCE, view: "grid", groupBy: undefined },
  masonry: { ...BASE_PREFERENCE, view: "masonry", groupBy: undefined },
  list: {
    ...BASE_PREFERENCE,
    view: "list",
    groupBy: { type: "system", key: "updatedAt" },
  },
};

function isExplorerPreviewSize(value: unknown): value is ExplorerPreviewSize {
  return value === "compact" || value === "normal" || value === "large";
}

/**
 * Local per-tab display state initialized from `WorkspaceLocalState` so split
 * All-Content views keep independent view modes and column settings.
 */
export function useAllDocsOptions() {
  const workspaceLocalState = useService(WorkspaceLocalState);

  const readViewMode = useCallback(
    () => workspaceLocalState.get<AllDocsViewMode>("allDocsMode") ?? "list",
    [workspaceLocalState],
  );

  const readDisplayPreference = useCallback(
    (mode: AllDocsViewMode): ExplorerDisplayPreference => {
      const saved = workspaceLocalState.get<ExplorerDisplayPreference>(
        `allDocsDisplayPreference:${mode}`,
      );
      return {
        ...DEFAULT_DISPLAY_PREFERENCES[mode],
        ...saved,
        view: mode,
        previewSize: isExplorerPreviewSize(saved?.previewSize)
          ? saved.previewSize
          : "normal",
      };
    },
    [workspaceLocalState],
  );

  const [viewMode, setViewModeState] = useState<AllDocsViewMode>(readViewMode);
  const [displayPreference, setDisplayPreferenceState] =
    useState<ExplorerDisplayPreference>(() => readDisplayPreference(viewMode));

  const setViewMode = useCallback(
    (nextMode: AllDocsViewMode) => {
      workspaceLocalState.set("allDocsMode", nextMode);
      setViewModeState(nextMode);
      setDisplayPreferenceState(readDisplayPreference(nextMode));
    },
    [readDisplayPreference, workspaceLocalState],
  );

  const setDisplayPreference = useCallback(
    (nextPreference: ExplorerDisplayPreference) => {
      workspaceLocalState.set(
        `allDocsDisplayPreference:${viewMode}`,
        nextPreference,
      );
      setDisplayPreferenceState(nextPreference);
    },
    [viewMode, workspaceLocalState],
  );

  return {
    viewMode,
    setViewMode,
    displayPreference,
    setDisplayPreference,
  };
}
