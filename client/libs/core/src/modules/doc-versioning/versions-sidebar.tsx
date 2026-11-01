// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useHistoryNavigation } from "./history-navigation";
import { useGuard } from "@myoxus/core/components/guard";
import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import {
  historySourceI18nKey,
  useDocumentHistory,
  useDocumentVersioningOverview,
  sortNamedDocumentVersions,
} from "@myoxus/core/modules/doc-versioning/history-data";
import type { GraphQLService } from "@myoxus/core/modules/server";
import { HistoryIcon, ResetIcon, SettingsIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Button,
  Group,
  IconButton,
  Loading,
  MyoxusText,
  SettingsNotice,
  Stack,
  SurfaceList,
  SurfaceListAction,
  SurfaceListItem,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DocumentHistoryCaptureDialog } from "./capture-dialog";
import { type DocumentVersion } from "./types";

export interface DocumentVersionsSidebarProps {
  workspaceId: string;
  docId: string;
  graphqlService: GraphQLService;
  beforeCapture: () => Promise<void>;
  refreshMetadata: () => Promise<unknown>;
  readonly?: boolean;
  visible?: boolean;
}

function sortVersions(versions: DocumentVersion[]): DocumentVersion[] {
  return sortNamedDocumentVersions(versions).sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return 0;
  });
}

/** Compact document entry point; the full history view owns version management. */
export function DocumentVersionsSidebar({
  workspaceId,
  docId,
  graphqlService,
  beforeCapture,
  refreshMetadata,
  readonly = false,
  visible = true,
}: DocumentVersionsSidebarProps) {
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const scope = useMemo(
    () => ({ workspaceId, docId, graphqlService }),
    [workspaceId, docId, graphqlService],
  );
  const activeScope = useRef<typeof scope | null>(scope);
  activeScope.current = scope;
  useEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);
  const [readFailure, setReadFailure] = useState<{
    scope: typeof scope;
    message: string;
  } | null>(null);
  const error = readFailure?.scope === scope ? readFailure.message : null;
  const [createOpen, setCreateOpen] = useState(false);
  const historyNavigation = useHistoryNavigation();
  const historyTrigger = useRef<HTMLElement | null>(null);
  const surfaceVisible = visible && !historyNavigation.state.open;
  const [overview, loading, overviewState] = useDocumentVersioningOverview(
    graphqlService,
    workspaceId,
    docId,
    surfaceVisible,
  );
  const versions = sortVersions(overview?.documentVersions ?? []);
  const historySettings = overview?.workspaceHistorySettings;
  const [histories, , , historyState] = useDocumentHistory(
    workspaceId,
    docId,
    false,
    surfaceVisible,
  );
  const workspaceDialogService = useService(WorkspaceDialogService);
  const canManageWorkspaceSettings = useGuard("Workspace_Settings_Update");
  const loadFailedMessage =
    t["com.myoxus.sidebar.document-versions.error.load-failed"]();

  const openHistory = useCallback(
    (trigger?: HTMLElement, snapshotId?: string) => {
      historyTrigger.current =
        trigger ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
      historyNavigation.open(
        snapshotId ? { snapshotId } : undefined,
        historyTrigger.current,
      );
    },
    [historyNavigation],
  );

  const openSave = useCallback(() => {
    historyTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    const onMenuAction = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          action: "new-version" | "restore-version";
          docId: string;
        }>
      ).detail;
      if (!detail || detail.docId !== docId) return;
      if (detail.action === "new-version" && !readonly) openSave();
      if (detail.action === "restore-version" && !readonly) {
        openHistory();
      }
    };
    window.addEventListener(
      "myoxus:document-version-menu-action",
      onMenuAction,
    );
    return () =>
      window.removeEventListener(
        "myoxus:document-version-menu-action",
        onMenuAction,
      );
  }, [docId, openHistory, openSave, readonly]);

  const refresh = async () => {
    setReadFailure(null);
    try {
      await Promise.all([
        overviewState.refresh(),
        historyState.refresh(),
        refreshMetadata(),
      ]);
    } catch (cause) {
      // A completed old-scope refresh must not report an error on another doc.
      if (activeScope.current === scope)
        setReadFailure({
          scope,
          message: cause instanceof Error ? cause.message : loadFailedMessage,
        });
    }
  };

  // Both reads must finish successfully before absence can be reported as empty.
  const confirmedEmpty =
    !loading &&
    !historyState.loading &&
    !error &&
    !overviewState.error &&
    !historyState.error &&
    histories.length === 0;

  return (
    <Stack
      aria-label={t["com.myoxus.sidebar.document-versions.aria-label"]()}
      component="section"
      data-empty={confirmedEmpty ? "true" : undefined}
      data-myoxus-ui-role="document-versions-panel"
      data-testid="document-versions-sidebar"
    >
      {readonly ? (
        <SettingsNotice tone="info">
          {t["com.myoxus.no-permission"]()}
        </SettingsNotice>
      ) : null}
      <Group component="header" data-myoxus-ui-role="document-versions-header">
        {!readonly ? (
          <Button
            data-testid="document-version-new"
            onClick={openSave}
            variant="primary"
          >
            {t["com.myoxus.sidebar.document-versions.action.save-state"]()}
          </Button>
        ) : null}
        <Button
          data-testid="document-version-history"
          onClick={(event) => openHistory(event.currentTarget)}
          prefix={<HistoryIcon />}
          variant="secondary"
        >
          {t["com.myoxus.history.action.all-states"]()}
        </Button>
        {canManageWorkspaceSettings ? (
          <IconButton
            data-testid="document-version-automation-settings"
            icon={<SettingsIcon />}
            onClick={() =>
              workspaceDialogService.open("workspace-settings", {
                activeTab: "workspace:documents",
                scrollAnchor: "automatic-capture",
              })
            }
            tooltip={t["com.myoxus.history.action.automation-settings"]()}
          />
        ) : null}
        <IconButton
          data-testid="document-version-refresh"
          disabled={loading}
          icon={<ResetIcon />}
          onClick={() => void refresh()}
          tooltip={t["com.myoxus.sidebar.action.refresh"]()}
        />
      </Group>

      {historySettings ? (
        <SettingsNotice>
          {historySettings.runtimeAvailable
            ? t["com.myoxus.history.automation.summary"]({
                interval: String(
                  historySettings.effectiveEditCaptureIntervalMs / 60_000,
                ),
                state: historySettings.effectiveEditCaptureEnabled
                  ? t[
                      "com.myoxus.settings.workspace.documents.history.value.enabled"
                    ]()
                  : t[
                      "com.myoxus.settings.workspace.documents.history.value.disabled"
                    ](),
              })
            : t[
                "com.myoxus.settings.workspace.documents.history.notice.pending"
              ]()}
          {histories[0]
            ? ` ${t["com.myoxus.history.last-capture"]({ date: formatDateTime(histories[0].timestamp) })}`
            : ""}
        </SettingsNotice>
      ) : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {overviewState.error ? (
        <SettingsNotice tone="error">
          {loadFailedMessage}
          <Button onClick={() => void overviewState.retry()}>
            {t["Retry"]()}
          </Button>
        </SettingsNotice>
      ) : null}
      {loading ? (
        <Loading
          aria-label={t["com.myoxus.sidebar.document-versions.loading"]()}
          data-testid="document-versions-loading"
        />
      ) : null}
      {confirmedEmpty ? (
        <MyoxusText data-testid="document-versions-empty">
          {t["com.myoxus.sidebar.document-versions.empty"]()}
        </MyoxusText>
      ) : null}
      {historyState.error ? (
        <SettingsNotice tone="error">
          {t["com.myoxus.sidebar.document-versions.error.load-failed"]()}
          <Button onClick={() => void historyState.retry()}>
            {t["Retry"]()}
          </Button>
        </SettingsNotice>
      ) : null}
      {histories.length ? (
        <SurfaceList data-myoxus-ui-role="document-history-recent-list">
          {histories.slice(0, 5).map((history) => {
            const version = versions.find(
              (candidate) => candidate.docHistoryId === history.snapshotId,
            );
            return (
              <SurfaceListItem
                appearance="row"
                density="compact"
                fullWidth
                key={history.snapshotId}
                layout="row"
              >
                <SurfaceListAction
                  data-testid="document-history-recent-item"
                  data-snapshot-id={history.snapshotId}
                  onClick={(event) =>
                    openHistory(event.currentTarget, history.snapshotId)
                  }
                >
                  <Stack>
                    <SurfaceListText kind="title" truncate={false}>
                      {version?.label ??
                        t[historySourceI18nKey(history.origin)]()}
                    </SurfaceListText>
                    <MyoxusText tone="secondary" typographySlot="body-small">
                      {formatDateTime(history.timestamp)}
                      {history.editor ? ` · ${history.editor.name}` : ""}
                    </MyoxusText>
                  </Stack>
                </SurfaceListAction>
              </SurfaceListItem>
            );
          })}
        </SurfaceList>
      ) : null}
      {!readonly ? (
        <DocumentHistoryCaptureDialog
          returnFocusRef={historyTrigger}
          beforeCapture={beforeCapture}
          docId={docId}
          graphqlService={graphqlService}
          onCaptured={async (captured) => {
            if (activeScope.current !== scope) return;
            const createdVersion = captured.version;
            historyNavigation.open(
              {
                snapshotId: captured.historyId,
                versionId: createdVersion?.id,
              },
              historyTrigger.current,
            );
            if (createdVersion) await refresh();
            else
              await Promise.all([overviewState.retry(), historyState.retry()]);
          }}
          onOpenChange={setCreateOpen}
          open={createOpen}
          workspaceId={workspaceId}
        />
      ) : null}
    </Stack>
  );
}

export const __test__ = { sortVersions };
