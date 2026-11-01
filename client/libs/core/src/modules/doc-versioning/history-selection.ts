// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  getInitialPageHistorySnapshotId,
  useHistoryMetadata,
  type DocHistory,
} from "./history-data";
import type { HistoryRestoreTarget } from "./restore-action";
import type { DocumentVersioningOverviewResponse } from "./types";

export interface HistorySelection {
  snapshotId: string;
  /** Only explicit reference selection or a committed named save sets this. */
  versionId?: string;
}

/** A label never promotes a snapshot to named restore. Capture metadata and
 * the current scoped overview validate identity before preparing any restore. */
export function useHistorySelection({
  workspaceId,
  docId,
  histories,
  overview,
  overviewLoading,
  historyLoading,
  visible = true,
  selection,
  onSelectionChange,
  selectInitial = true,
}: {
  workspaceId: string;
  docId: string;
  histories: DocHistory[];
  overview?: DocumentVersioningOverviewResponse;
  overviewLoading: boolean;
  historyLoading: boolean;
  visible?: boolean;
  selection?: HistorySelection;
  onSelectionChange: (selection: HistorySelection) => void;
  selectInitial?: boolean;
}) {
  const scope = useMemo(() => ({ workspaceId, docId }), [workspaceId, docId]);
  // The owning View supplies current-scope intent. A delayed old callback
  // must not replace the successor document's URL selection.
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const select = useCallback(
    (next: HistorySelection) => {
      if (currentScope.current !== scope) return;
      onSelectionChange(next);
    },
    [scope, onSelectionChange],
  );
  useEffect(() => {
    if (!selectInitial || selection || overviewLoading || historyLoading)
      return;
    const snapshotId = getInitialPageHistorySnapshotId(
      histories,
      overview?.documentVersions ?? [],
    );
    if (snapshotId) select({ snapshotId });
  }, [
    selection,
    overviewLoading,
    historyLoading,
    histories,
    overview,
    select,
    selectInitial,
  ]);
  const metadataState = useHistoryMetadata(
    workspaceId,
    docId,
    selection?.snapshotId,
    visible,
  );
  const selectedVersion = overview?.documentVersions.find(
    (version) =>
      version.id === selection?.versionId &&
      version.docHistoryId === selection?.snapshotId &&
      version.workspaceId === workspaceId &&
      version.docId === overview.documentMetadata?.docId,
  );
  const referenceMissing =
    !!selection?.versionId && !overviewLoading && !selectedVersion;
  const metadata =
    metadataState.metadata?.snapshotId === selection?.snapshotId
      ? metadataState.metadata
      : undefined;
  const unavailable =
    (!!selection &&
      !metadataState.loading &&
      !metadataState.error &&
      !metadata) ||
    referenceMissing;
  const restoreTarget: HistoryRestoreTarget | null =
    selection &&
    metadata &&
    !metadataState.loading &&
    !metadataState.error &&
    (!selection.versionId || (!overviewLoading && selectedVersion))
      ? selection.versionId
        ? { versionId: selection.versionId }
        : { snapshotId: selection.snapshotId }
      : null;
  return {
    ...metadataState,
    selection,
    select,
    metadata,
    selectedVersion,
    referenceMissing,
    unavailable,
    restoreTarget,
    timestamp: metadata?.timestamp,
  };
}
