// SPDX-License-Identifier: AGPL-3.0-or-later
import { EmptyHistoryShape } from "@myoxus/core/components/myoxus/page-history-modal/empty-history-shape";
import { useDocumentViewContext } from "@myoxus/core/components/hooks/use-document-view-context";
import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { PureEditorModeSwitch } from "@myoxus/core/editor/virgultum/mode-switch";
import { DocService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { useHistoryManager } from "@myoxus/core/modules/doc-versioning/history-manager";
import { useHistoryNavigation } from "@myoxus/core/modules/doc-versioning/history-navigation";
import { HistoryPreviewContent } from "@myoxus/core/modules/doc-versioning/history-preview-content";
import { HistoryTimeline } from "@myoxus/core/modules/doc-versioning/history-timeline";
import { DocumentVersionDiffViewer } from "@myoxus/core/modules/doc-versioning/diff-viewer";
import { EditorService } from "@myoxus/core/modules/editor";
import {
  useIsActiveView,
  ViewBody,
  ViewHeader,
  ViewTitle,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { SettingsIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  FormSelect,
  EmptyState,
  Grid,
  Group,
  IconButton,
  Loading,
  MyoxusSegmentedControl,
  MyoxusText,
  Scrollable,
  SettingsNotice,
  Stack,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

/** A document subview inside the existing RouteContainer shell, never a second editor host. */
export function HistoryView() {
  const doc = useService(DocService).doc;
  const workspace = useService(WorkspaceService).workspace;
  const navigation = useHistoryNavigation();
  const active = useIsActiveView();
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const title = t.t(
    useLiveData(useService(DocDisplayMetaService).title$(doc.id)),
  );
  const editorMode = useLiveData(useService(EditorService).editor.mode$);
  const trash = useLiveData(doc.meta$.map((meta) => meta.trash));
  useDocumentViewContext({
    active,
    docId: doc.id,
    editorContainer: null,
    isInTrash: trash,
    mode: editorMode,
  });
  const model = useHistoryManager({
    docCollection: workspace.docCollection,
    pageId: doc.id,
    onClose: navigation.close,
    controlledSelection: navigation.state.selection,
    onSelectionChange: navigation.select,
    invalidSelection: navigation.state.invalid,
    visible: active,
  });
  // ViewHeader is an island: its node mounts after this component's effects.
  const back = useCallback(
    (node: HTMLButtonElement | null) => {
      if (active) node?.focus();
    },
    [active],
  );
  const settings = model.overview?.workspaceHistorySettings;
  const unavailable =
    navigation.state.invalid || model.selectionState.unavailable;
  const failed =
    model.historyState.error ||
    model.namedState.error ||
    model.selectionState.error;
  const hasCanvas =
    !!model.snapshotPage?.getBlocksByFlavour("myoxus:surface").length;
  const previewMode = hasCanvas ? model.mode : "page";
  const canCapture = model.canUpdate && !trash;
  return (
    <>
      <ViewTitle title={title} />
      <ViewHeader>
        <WorkbenchHeaderFrame
          title={
            <WorkbenchHeaderContextPath
              current={title}
              parents={[t["com.myoxus.history.version-history"]()]}
            />
          }
          right={
            <Group>
              <Button
                ref={model.captureTrigger}
                data-testid="history-save-current-state"
                disabled={!canCapture}
                onClick={model.openCapture}
              >
                {t["com.myoxus.sidebar.document-versions.action.save-state"]()}
              </Button>
              {model.canManageWorkspaceSettings ? (
                <IconButton
                  data-testid="history-automation-settings"
                  icon={<SettingsIcon />}
                  tooltip={t["com.myoxus.history.action.automation-settings"]()}
                  onClick={model.openAutomationSettings}
                />
              ) : null}
              <Button
                ref={back}
                data-testid="history-back-to-document"
                onClick={navigation.close}
              >
                {t["com.myoxus.history.back-to-page"]()}
              </Button>
            </Group>
          }
        />
      </ViewHeader>
      <ViewBody>
        {/* Scope Grid alignment rather than inheriting the outer shell's flex-start.
            Flex growth provides a definite timeline/canvas viewport without fixed sizes. */}
        <Grid
          data-testid="document-history-view"
          align="stretch"
          display="flex"
          flex="1 1 auto"
          w="100%"
          styles={{ root: { flexDirection: "column" }, inner: { flex: 1 } }}
        >
          <Grid.Col span={4} display="flex" mih={0}>
            <Stack flex="1 1 0" mih={0}>
              {settings ? (
                <SettingsNotice>
                  {settings.runtimeAvailable
                    ? t["com.myoxus.history.automation.summary"]({
                        interval: String(
                          settings.effectiveEditCaptureIntervalMs / 60_000,
                        ),
                        state: settings.effectiveEditCaptureEnabled
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
                  {settings.lastEditCaptureAt ? (
                    <MyoxusText component="p" tone="secondary">
                      {t["com.myoxus.history.workspace-last-automatic-capture"](
                        { date: formatDateTime(settings.lastEditCaptureAt) },
                      )}
                    </MyoxusText>
                  ) : null}
                </SettingsNotice>
              ) : null}
              {model.historyState.loading && !model.historyList.length ? (
                <Loading />
              ) : (
                <HistoryTimeline
                  historyList={model.historyList}
                  namedVersions={model.namedVersions}
                  selection={model.selection}
                  onSelectionChange={model.selectVersion}
                  namedOnly={model.namedOnly}
                  onNamedOnlyChange={model.setNamedOnly}
                  loadingMore={model.loadingMore}
                  onLoadMore={model.loadMore}
                  canName={canCapture}
                  onName={model.openName}
                  onEdit={model.openEdit}
                  onTogglePin={(version) => void model.togglePin(version)}
                  versionActionBusy={model.versionActionBusy}
                />
              )}
            </Stack>
          </Grid.Col>
          <Grid.Col span={8} display="flex" mih={0}>
            <Stack
              flex="1 1 0"
              mih={0}
              miw={0}
              data-myoxus-ui-role="page-history-preview-shell"
            >
              {failed || unavailable ? (
                <SettingsNotice tone="error" data-testid="history-unavailable">
                  {t[
                    "com.myoxus.sidebar.document-versions.error.load-failed"
                  ]()}
                  {!navigation.state.invalid ? (
                    <Button onClick={model.retry}>{t["Retry"]()}</Button>
                  ) : null}
                </SettingsNotice>
              ) : null}
              {!model.canUpdate ? (
                <SettingsNotice>
                  {t["com.myoxus.history.update-denied"]()}
                </SettingsNotice>
              ) : null}
              {model.restoreError ? (
                <SettingsNotice tone="error">
                  {model.restoreError}
                </SettingsNotice>
              ) : null}
              {model.versionActionError ? (
                <SettingsNotice tone="error">
                  {model.versionActionError}
                </SettingsNotice>
              ) : null}
              {model.activeVersion ? (
                <>
                  <Stack
                    component="header"
                    data-myoxus-ui-role="page-history-preview-header"
                    data-capture-time={model.selectedTimestamp}
                  >
                    <Group justify="space-between">
                      <MyoxusText data-myoxus-ui-role="page-history-preview-title">
                        {model.selectedVersion?.label ?? model.title}
                      </MyoxusText>
                      {model.selectedTimestamp ? (
                        <MyoxusText
                          data-myoxus-ui-role="page-history-preview-timestamp"
                          tone="secondary"
                        >
                          {formatDateTime(model.selectedTimestamp)}
                        </MyoxusText>
                      ) : null}
                      <Button
                        ref={model.restoreTrigger}
                        data-testid="history-restore-selected"
                        disabled={model.isMutating || !model.restoreAvailable}
                        onClick={() => void model.onConfirmRestore()}
                      >
                        {t[
                          "com.myoxus.sidebar.document-versions.action.restore"
                        ]()}
                      </Button>
                    </Group>
                    <FormSelect
                      label={t["com.myoxus.sidebar.document-versions.title"]()}
                      placeholder={t["Snapshot"]()}
                      data-testid="history-named-version-select"
                      searchable
                      clearable
                      clearButtonProps={{
                        "aria-label": t["com.myoxus.common.clear-selection"](),
                        "aria-hidden": false,
                        tabIndex: 0,
                      }}
                      value={model.selection?.versionId ?? null}
                      data={model.namedVersions.map((version) => ({
                        value: version.id,
                        label: version.label,
                      }))}
                      onClear={() => {
                        if (model.selection)
                          model.selectVersion({
                            snapshotId: model.selection.snapshotId,
                          });
                      }}
                      onChange={(id) => {
                        const version = model.namedVersions.find(
                          (version) => version.id === id,
                        );
                        if (version)
                          model.selectVersion({
                            snapshotId: version.docHistoryId,
                            versionId: version.id,
                          });
                      }}
                    />
                    <MyoxusSegmentedControl
                      layout="fluid"
                      aria-label={t["com.myoxus.history.version-history"]()}
                      data={[
                        {
                          value: "preview",
                          label: t["com.myoxus.history.mode.preview"](),
                          testId: "history-mode-preview",
                        },
                        {
                          value: "changes",
                          label: t["com.myoxus.history.mode.changes"](),
                          testId: "history-mode-changes",
                        },
                      ]}
                      value={navigation.state.mode}
                      onChange={(value) =>
                        navigation.setMode(
                          value === "changes" ? "changes" : "preview",
                        )
                      }
                    />
                    {navigation.state.mode === "preview" ? (
                      <PureEditorModeSwitch
                        mode={previewMode}
                        setMode={model.setMode}
                        hideEdgeless={!hasCanvas}
                      />
                    ) : null}
                  </Stack>
                  {unavailable || model.selectionState.error ? null : navigation
                      .state.mode === "changes" ? (
                    model.selectedTimestamp ? (
                      <Scrollable.Root flex="1 1 auto" minHeight={0}>
                        <Scrollable.Viewport fill>
                          <DocumentVersionDiffViewer
                            visible={active}
                            workspace={workspace}
                            docId={model.pageDocId}
                            snapshotId={model.activeVersion}
                            captureTime={model.selectedTimestamp}
                            label={model.selectedVersion?.label}
                            graphqlService={model.graphQLService}
                          />
                        </Scrollable.Viewport>
                        <Scrollable.Scrollbar />
                      </Scrollable.Root>
                    ) : (
                      <Loading />
                    )
                  ) : (
                    <HistoryPreviewContent
                      page={model.snapshotPage}
                      mode={previewMode}
                      error={model.snapshotState.error}
                      onRetry={() => void model.snapshotState.retry()}
                    />
                  )}
                </>
              ) : unavailable || failed ? null : model.namedVersionsLoading ||
                model.historyState.loading ? (
                <Loading />
              ) : (
                <EmptyState
                  data-testid="empty-history-prompt"
                  media={<EmptyHistoryShape />}
                  title={t["com.myoxus.history.empty-prompt.title"]()}
                  description={t[
                    "com.myoxus.history.empty-prompt.description"
                  ]()}
                />
              )}
            </Stack>
          </Grid.Col>
        </Grid>
      </ViewBody>
      {model.dialogs}
    </>
  );
}
