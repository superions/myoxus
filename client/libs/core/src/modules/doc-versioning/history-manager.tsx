// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT
import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { DocumentVersion } from "./types";
import type { PreparedHistoryRestore } from "./restore-action";
import {
  nameDocumentHistoryStateMutation,
  pinDocumentVersionMutation,
  unpinDocumentVersionMutation,
  updateDocumentVersionMutation,
} from "./types";
import { DocumentVersionNameModal } from "./version-name-modal";
import { DocumentHistoryCaptureDialog } from "./capture-dialog";
import {
  useDocumentHistory,
  useDocumentVersioningOverview,
  sortNamedDocumentVersions,
} from "./history-data";
import {
  useHistorySelection,
  type HistorySelection,
} from "./history-selection";
import { useRestorePage, useSnapshotPage } from "./history-preview";
import { waitForDocumentVersionSync } from "./document-sync";
import { useGuard } from "@myoxus/core/components/guard";
import { EditorService } from "@myoxus/core/modules/editor";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { GraphQLService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { ConfirmModal, ModalStack, notify } from "@myoxus/ui-facade";
import type { DocMode, RootBlockModel } from "@virgultum/editor/model";
import type { Workspace } from "@virgultum/editor/store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Preserve the existing mutation/read owners; the document host owns layout and URL state. */
export const useHistoryManager = ({
  docCollection,
  pageId,
  onClose,
  controlledSelection,
  onSelectionChange,
  invalidSelection = false,
  visible,
}: {
  docCollection: Workspace;
  pageId: string;
  onClose: () => void;
  controlledSelection?: HistorySelection;
  onSelectionChange: (selection: HistorySelection) => void;
  invalidSelection?: boolean;
  visible: boolean;
}) => {
  const workspaceId = docCollection.id;
  const preparationGeneration = useRef(0);
  const restoreTrigger = useRef<HTMLButtonElement | null>(null);
  const captureTrigger = useRef<HTMLButtonElement | null>(null);
  const nameTrigger = useRef<HTMLElement | null>(null);
  const editTrigger = useRef<HTMLElement | null>(null);
  useEffect(
    () => () => {
      preparationGeneration.current++;
    },
    [],
  );

  const pageDocId = useMemo(() => {
    return docCollection.getDoc(pageId)?.spaceDoc.guid ?? pageId;
  }, [pageId, docCollection]);
  const [pendingRestore, setPendingRestore] = useState<{
    request: PreparedHistoryRestore;
    label: string;
  } | null>(null);
  const [nameTarget, setNameTarget] = useState<{
    snapshotId: string;
    versionIds: string[];
  } | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [editVersion, setEditVersion] = useState<DocumentVersion | null>(null);
  const [versionActionBusy, setVersionActionBusy] = useState<string | null>(
    null,
  );
  const [versionActionError, setVersionActionError] = useState<string | null>(
    null,
  );
  const [namedOnly, setNamedOnly] = useState(false);

  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const graphQLService = useService(GraphQLService);
  const { workspace } = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);

  const [historyList, loadMore, loadingMore, historyState] = useDocumentHistory(
    workspaceId,
    pageDocId,
    namedOnly,
    visible,
  );
  const [overview, namedVersionsLoading, namedState] =
    useDocumentVersioningOverview(
      graphQLService,
      workspaceId,
      pageDocId,
      visible,
    );
  const namedVersions = useMemo(
    () => sortNamedDocumentVersions(overview?.documentVersions ?? []),
    [overview],
  );
  const selectionState = useHistorySelection({
    workspaceId,
    docId: pageDocId,
    selection: controlledSelection,
    onSelectionChange,
    selectInitial: !invalidSelection,
    histories: historyList,
    overview,
    overviewLoading: namedVersionsLoading,
    historyLoading: historyState.loading,
    visible,
  });
  const {
    selection,
    select: selectHistory,
    selectedVersion,
    referenceMissing,
    timestamp: selectedTimestamp,
  } = selectionState;
  const activeVersion = selection?.snapshotId;
  const selectVersion = useCallback(
    (next: HistorySelection) => {
      preparationGeneration.current++;
      selectHistory(next);
    },
    [selectHistory],
  );
  useEffect(() => {
    preparationGeneration.current++;
    setPendingRestore(null);
  }, [selection, visible]);
  const snapshotState = useSnapshotPage(
    docCollection,
    pageDocId,
    activeVersion,
    visible,
  );
  const snapshotPage = snapshotState.page;

  const { prepare, onRestore, refresh, isMutating, restoreError } =
    useRestorePage(pageDocId, () =>
      Promise.all([historyState.refresh(), namedState.refresh()]),
    );

  const editor = useService(EditorService).editor;
  const [mode, setMode] = useState<DocMode>(editor.mode$.value);

  const title = String(
    (snapshotPage?.root as RootBlockModel | null)?.props.title ?? "",
  );
  const canRestore = useGuard("Doc_Restore", pageDocId);
  const canUpdate = useGuard("Doc_Update", pageDocId);
  const canManageWorkspaceSettings = useGuard("Workspace_Settings_Update");
  // Preparation and an already-open confirmation share the same read gates.
  // A failed refresh must not leave a stale confirmation writable.
  const restoreAvailable = !!(
    canRestore &&
    activeVersion &&
    snapshotPage &&
    !snapshotState.error &&
    selectedTimestamp &&
    !namedVersionsLoading &&
    !namedState.error &&
    !invalidSelection &&
    selectionState.restoreTarget
  );

  const openAutomationSettings = () => {
    if (!canManageWorkspaceSettings) return;
    workspaceDialogService.open(
      "workspace-settings",
      {
        activeTab: "workspace:documents",
        scrollAnchor: "automatic-capture",
      },
      () => {
        void Promise.all([historyState.retry(), namedState.retry()]);
      },
    );
  };

  const nameHistory = async (name: string, description: string | null) => {
    if (!nameTarget || nameBusy || !canUpdate) return;
    setNameBusy(true);
    setNameError(null);
    try {
      const data = await graphQLService.gql({
        query: nameDocumentHistoryStateMutation,
        variables: {
          workspaceId,
          docId: pageDocId,
          historyId: nameTarget.snapshotId,
          expectedVersionIds: nameTarget.versionIds,
          name,
          description,
        },
      });
      const version = data.nameDocumentHistoryState;
      selectVersion({
        snapshotId: nameTarget.snapshotId,
        versionId: version.id,
      });
      setNameTarget(null);
      // Naming has committed. A failed follow-up read is represented by the
      // history error state and must not reopen a form that could duplicate it.
      await Promise.all([historyState.retry(), namedState.retry()]);
    } catch (error) {
      setNameError(
        error instanceof Error
          ? error.message
          : t["com.myoxus.sidebar.document-versions.error.create-failed"](),
      );
      await Promise.all([historyState.retry(), namedState.retry()]);
    } finally {
      setNameBusy(false);
    }
  };

  const updateVersion = async (label: string, description: string | null) => {
    if (!canUpdate || !editVersion || versionActionBusy) return;
    setVersionActionBusy(editVersion.id);
    setVersionActionError(null);
    try {
      await graphQLService.gql({
        query: updateDocumentVersionMutation,
        variables: { id: editVersion.id, label, description },
      });
      setEditVersion(null);
      await namedState.retry();
    } catch (error) {
      setVersionActionError(
        error instanceof Error
          ? error.message
          : t["com.myoxus.sidebar.document-versions.error.update-failed"](),
      );
    } finally {
      setVersionActionBusy(null);
    }
  };

  const togglePin = async (version: DocumentVersion) => {
    if (!canUpdate || versionActionBusy) return;
    setVersionActionBusy(version.id);
    setVersionActionError(null);
    try {
      await graphQLService.gql({
        query: version.isPinned
          ? unpinDocumentVersionMutation
          : pinDocumentVersionMutation,
        variables: { id: version.id },
      });
      await namedState.retry();
    } catch (error) {
      setVersionActionError(
        error instanceof Error
          ? error.message
          : t["com.myoxus.sidebar.document-versions.error.pin-failed"](),
      );
    } finally {
      setVersionActionBusy(null);
    }
  };

  const onConfirmRestore = async () => {
    if (
      !restoreAvailable ||
      !selectedTimestamp ||
      !selectionState.restoreTarget
    )
      return;
    const generation = ++preparationGeneration.current;
    const timestampLabel = formatDateTime(selectedTimestamp);
    const label = selectedVersion?.label
      ? `${selectedVersion.label} · ${timestampLabel}`
      : timestampLabel;
    const prepared = await prepare(selectionState.restoreTarget);
    // Selection or closing the preview invalidates an in-flight preparation.
    if (!prepared || generation !== preparationGeneration.current) return;
    setPendingRestore({ request: prepared, label });
  };

  return {
    workspace,
    graphQLService,
    workspaceId,
    pageDocId,
    overview,
    historyList,
    loadMore,
    loadingMore,
    historyState,
    namedVersions,
    namedVersionsLoading,
    namedState,
    selectionState,
    selection,
    selectedVersion,
    selectedTimestamp,
    activeVersion,
    selectVersion,
    snapshotState,
    snapshotPage,
    mode,
    setMode,
    title,
    canRestore,
    canUpdate,
    canManageWorkspaceSettings,
    restoreAvailable,
    isMutating,
    restoreError,
    versionActionError,
    versionActionBusy,
    restoreTrigger,
    captureTrigger,
    namedOnly,
    setNamedOnly,
    openAutomationSettings,
    onConfirmRestore,
    openCapture: () => {
      if (canUpdate) setCaptureOpen(true);
    },
    openName: (
      snapshotId: string,
      versionIds: string[],
      opener?: HTMLElement | null,
    ) => {
      if (!canUpdate) return;
      nameTrigger.current = opener ?? null;
      setNameError(null);
      setNameTarget({ snapshotId, versionIds });
    },
    openEdit: (version: DocumentVersion, opener?: HTMLElement | null) => {
      if (!canUpdate) return;
      editTrigger.current = opener ?? null;
      setVersionActionError(null);
      setEditVersion(version);
    },
    togglePin,
    retry: () => {
      if (historyState.error) void historyState.retry();
      if (namedState.error || referenceMissing) void namedState.retry();
      if (selectionState.error || selectionState.unavailable)
        void selectionState.retry();
    },
    dialogs: (
      <ModalStack>
        <ConfirmModal
          stackId="history-restore"
          returnFocusRef={restoreTrigger}
          open={pendingRestore !== null}
          onOpenChange={(open) => {
            if (!open) setPendingRestore(null);
          }}
          title={t["com.myoxus.sidebar.document-versions.restore.title"]({
            label: pendingRestore?.label ?? "",
          })}
          description={t[
            "com.myoxus.sidebar.document-versions.restore.description"
          ]()}
          cancelText={t["Cancel"]()}
          contentOptions={{ "data-testid": "confirm-restore-history-modal" }}
          confirmText={t["com.myoxus.history.confirm-restore-modal.restore"]()}
          confirmButtonOptions={{
            variant: "primary",
            disabled: !restoreAvailable,
            "data-testid": "confirm-restore-history-button",
          }}
          onConfirm={async () => {
            if (!pendingRestore || !restoreAvailable || !visible) return;
            try {
              const result = await onRestore(pendingRestore.request);
              restoreTrigger.current = null;
              onClose();
              if (result.refreshError) {
                notify.warning(
                  {
                    title:
                      t[
                        "com.myoxus.sidebar.document-versions.restore.refresh-warning.title"
                      ](),
                    message:
                      t[
                        "com.myoxus.sidebar.document-versions.restore.refresh-warning.description"
                      ](),
                    actions: [
                      {
                        key: "refresh-restored-document",
                        label: t["com.myoxus.sidebar.action.refresh"](),
                        onClick: () => {
                          void refresh().catch((error) => notify.error(error));
                        },
                      },
                    ],
                  },
                  { duration: 0 },
                );
              }
            } catch {
              // The preview displays the failure. Retrying requires a fresh
              // revision and confirmation, never replaying an uncertain write.
            } finally {
              setPendingRestore(null);
            }
          }}
        />
        <DocumentVersionNameModal
          returnFocusRef={nameTrigger}
          busy={nameBusy}
          error={nameError}
          onClose={() => {
            setNameTarget(null);
            setNameError(null);
          }}
          onSubmit={(name, description) => {
            void nameHistory(name, description);
          }}
          open={nameTarget !== null}
          stackId="history-name"
          testId="history-name-modal"
          title={t["com.myoxus.history.action.name"]()}
        />
        <DocumentHistoryCaptureDialog
          returnFocusRef={captureTrigger}
          beforeCapture={() => waitForDocumentVersionSync(workspace, pageDocId)}
          docId={pageDocId}
          graphqlService={graphQLService}
          onCaptured={async (captured) => {
            selectVersion({
              snapshotId: captured.historyId,
              versionId: captured.version?.id,
            });
            await Promise.all([historyState.retry(), namedState.retry()]);
          }}
          onOpenChange={setCaptureOpen}
          open={captureOpen}
          workspaceId={workspaceId}
        />
        <DocumentVersionNameModal
          returnFocusRef={editTrigger}
          busy={versionActionBusy === editVersion?.id}
          error={versionActionError}
          initialDescription={editVersion?.description}
          initialLabel={editVersion?.label}
          onClose={() => {
            setEditVersion(null);
            setVersionActionError(null);
          }}
          onSubmit={(label, description) =>
            void updateVersion(label, description)
          }
          open={editVersion !== null}
          stackId="history-edit-version"
          testId="history-edit-version-modal"
          title={t["com.myoxus.sidebar.document-versions.modal.edit-title"]()}
        />
      </ModalStack>
    ),
  };
};
