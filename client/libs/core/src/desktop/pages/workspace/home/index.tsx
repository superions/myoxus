// SPDX-License-Identifier: AGPL-3.0-or-later

import { MyoxusCommandRegistry } from "@myoxus/core/commands";
import {
  TASK_CREATION_RETURN_FOCUS,
  TASK_HOME_ROW_RETURN_FOCUS,
  taskCreationReturnRoute,
} from "@myoxus/core/modules/database/tasks/creation-intent";
import { DatabaseTaskLifecycle, DatabaseTaskScope } from "@myoxus/graphql";
import { DocsService } from "@myoxus/core/modules/doc";
import { CollectionRulesService } from "@myoxus/core/modules/collection-rules";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { getCuratedCommands } from "@myoxus/core/modules/quicksearch/impls/commands";
import { GlobalState } from "@myoxus/core/modules/storage";
import { WorkspaceHomeAssistance } from "./assistance";
import {
  UserPreferencesService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import {
  ViewService,
  useIsActiveView,
  useWorkbenchSurfaceScrollViewport,
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import {
  ListChecksIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import {
  Box,
  Button,
  Group,
  IconButton,
  Menu,
  MenuItem,
  MyoxusText,
  MyoxusTitle,
  notify,
  PageContentRail,
  Stack,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DashboardGrid } from "./dashboard-grid";
import {
  getDashboardDocumentLimit,
  moveDashboardDashlet,
  resizeDashboardDashlet,
  resolveWorkspaceDashboardLayout,
  toWorkspaceDashboardLayout,
} from "./dashboard-layout";
import {
  createDashboardDocumentSnapshots,
  DashboardDocumentSection,
} from "./document-sections";
import { projectDashboardDocuments } from "./document-views";
import {
  DashboardNotificationIcon,
  DashboardNotificationSection,
} from "./notification-views";
import { DashboardSection } from "./section";
import { DashboardTaskSection } from "./task-section";
import { TodaySection } from "./today-section";

const dashboardSavedNotificationId = "workspace-dashboard-layout-saved";

const WorkspaceHomeHeader = ({
  canCustomize,
  canReset,
  editMode,
  onEdit,
  onFinish,
  onOpenAll,
  onReset,
  onRetry,
  saveStatus,
}: {
  canCustomize: boolean;
  canReset: boolean;
  editMode: boolean;
  onEdit: () => void;
  onFinish: () => void;
  onOpenAll: () => void;
  onReset: () => void;
  onRetry: () => void;
  saveStatus: "error" | "offline" | "saving" | null;
}) => {
  const t = useI18n();
  useLiveData(MyoxusCommandRegistry.revision$);
  const commands = getCuratedCommands({ docMode: undefined });

  const runCommand = useCallback((run: () => void | Promise<void>) => {
    try {
      void Promise.resolve(run()).catch((error) => {
        notify.error(UserFriendlyError.fromAny(error));
      });
    } catch (error) {
      notify.error(UserFriendlyError.fromAny(error));
    }
  }, []);

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="workspace-home-header"
      title={
        <WorkbenchHeaderContextPath
          current={t["com.myoxus.workspace-home.title"]()}
        />
      }
      right={
        <Group wrap="nowrap">
          {editMode ? (
            <>
              {saveStatus ? (
                <MyoxusText
                  aria-live="polite"
                  tone="secondary"
                  typographySlot="body-small"
                >
                  {saveStatus === "saving"
                    ? t["common.saving"]()
                    : saveStatus === "offline"
                      ? t["com.myoxus.workspace-home.layout.offline"]()
                      : t["com.myoxus.workspace-home.layout.save-failed"]()}
                </MyoxusText>
              ) : null}
              {saveStatus === "error" ? (
                <Box visibleFrom="md">
                  <Button variant="plain" onClick={onRetry}>
                    {t["Retry"]()}
                  </Button>
                </Box>
              ) : null}
              <Button onClick={onFinish}>
                {t["com.myoxus.m.explorer.folder.rename-confirm"]()}
              </Button>
              <Box visibleFrom="md">
                <Menu
                  title={t["com.myoxus.database.field.options"]()}
                  items={
                    <MenuItem disabled={!canReset} onSelect={onReset}>
                      {t[
                        "com.myoxus.settings.workspace.documents.action.reset"
                      ]()}
                    </MenuItem>
                  }
                >
                  <IconButton
                    aria-label={t["com.myoxus.database.field.options"]()}
                    icon={<MoreHorizontalIcon />}
                  />
                </Menu>
              </Box>
              <Box hiddenFrom="md">
                <Menu
                  title={t["com.myoxus.database.field.options"]()}
                  items={
                    <>
                      {saveStatus === "error" ? (
                        <MenuItem onSelect={onRetry}>{t["Retry"]()}</MenuItem>
                      ) : null}
                      <MenuItem disabled={!canReset} onSelect={onReset}>
                        {t[
                          "com.myoxus.settings.workspace.documents.action.reset"
                        ]()}
                      </MenuItem>
                    </>
                  }
                >
                  <IconButton
                    aria-label={t["com.myoxus.database.field.options"]()}
                    icon={<MoreHorizontalIcon />}
                  />
                </Menu>
              </Box>
            </>
          ) : commands.length ? (
            <Menu
              title={t["com.myoxus.command-center.quick-actions"]()}
              items={commands.map((command) => (
                <MenuItem
                  key={command.id}
                  prefixIcon={command.icon}
                  onSelect={() => runCommand(command.run)}
                >
                  {command.label.title}
                </MenuItem>
              ))}
            >
              <Button prefix={<PlusIcon />}>
                {t["com.myoxus.command-center.quick-actions"]()}
              </Button>
            </Menu>
          ) : null}
          {!editMode ? (
            <>
              <Box visibleFrom="md">
                {canCustomize ? (
                  <Button variant="plain" onClick={onEdit}>
                    {t["Customize"]()}
                  </Button>
                ) : null}
              </Box>
              <Box visibleFrom="md">
                <Menu
                  title={t["com.myoxus.database.field.options"]()}
                  items={
                    <MenuItem onSelect={onOpenAll}>
                      {t["All content"]()}
                    </MenuItem>
                  }
                >
                  <IconButton
                    aria-label={t["com.myoxus.database.field.options"]()}
                    icon={<MoreHorizontalIcon />}
                  />
                </Menu>
              </Box>
              <Box hiddenFrom="md">
                <Menu
                  title={t["com.myoxus.database.field.options"]()}
                  items={
                    <>
                      <MenuItem onSelect={onOpenAll}>
                        {t["All content"]()}
                      </MenuItem>
                      {canCustomize ? (
                        <MenuItem onSelect={onEdit}>
                          {t["Customize"]()}
                        </MenuItem>
                      ) : null}
                    </>
                  }
                >
                  <IconButton
                    aria-label={t["com.myoxus.database.field.options"]()}
                    icon={<MoreHorizontalIcon />}
                  />
                </Menu>
              </Box>
            </>
          ) : null}
        </Group>
      }
    />
  );
};

export const WorkspaceHomePage = () => {
  const t = useI18n();
  const docsService = useService(DocsService);
  const collectionRules = useService(CollectionRulesService);
  const documentMetadataCache = useService(DocumentMetadataCacheService);
  const metadataIndex = useLiveData(documentMetadataCache.watchIndexState());
  const workspace = useService(WorkspaceService).workspace;
  const globalState = useService(GlobalState);
  const workspaceServer = useLiveData(
    workspace.scope.get(WorkspaceServerService).server$,
  );
  const preferences = useService(UserPreferencesService);
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const location = useLiveData(view.location$);
  const isActiveView = useIsActiveView();
  const scrollViewport = useWorkbenchSurfaceScrollViewport();
  const newTaskRef = useRef<HTMLButtonElement>(null);
  const openTasksRef = useRef<HTMLButtonElement>(null);
  const openTasks = useCallback(
    (databaseId?: string, rowId?: string, create = false) => {
      const scroll = scrollViewport.current?.scrollTop ?? 0;
      view.setScrollPosition(scroll);
      const params = new URLSearchParams({
        scope: DatabaseTaskScope.Mine,
        lifecycle: DatabaseTaskLifecycle.Open,
      });
      const home = view.location$.value;
      const returnTo = `${home.pathname}${home.search}`;
      if (databaseId && rowId) {
        params.set("databaseId", databaseId);
        params.set("rowId", rowId);
        params.set("returnRowId", rowId);
        // Browser Back reads this same one-shot return command as detail Close.
        view.replace(taskCreationReturnRoute(returnTo, String(scroll), rowId));
      }
      if (create) params.set("create", "task");
      if (create || rowId) {
        params.set("origin", "home");
        params.set("returnTo", returnTo);
        params.set("returnScroll", String(scroll));
      }
      workbench.open(`/tasks?${params}`, { at: "active" });
    },
    [scrollViewport, view, workbench],
  );

  const restoreHomeReturn = useCallback(
    (previewReady = false) => {
      if (!isActiveView) return;
      const home = view.location$.value;
      if (home.pathname !== "/home") return;
      const params = new URLSearchParams(home.search);
      const creationFocus = params.get("focus") === TASK_CREATION_RETURN_FOCUS;
      const rowFocus = params.get("focus") === TASK_HOME_ROW_RETURN_FOCUS;
      const requestedScroll = params.get("taskReturnScroll");
      const saved = view.getScrollPosition();
      const position =
        (creationFocus || rowFocus) &&
        requestedScroll &&
        /^\d+(?:\.\d+)?$/.test(requestedScroll) &&
        Number.isFinite(Number(requestedScroll))
          ? Number(requestedScroll)
          : typeof saved === "number"
            ? saved
            : 0;
      const viewport = scrollViewport.current;
      if (!viewport) return;
      viewport.scrollTop = position;
      if (!creationFocus && !rowFocus) return;
      // Both return commands wait for the preview to commit its result or failure.
      if (!previewReady) return;
      const rowId = params.get("returnRowId");
      const row =
        rowFocus && rowId
          ? viewport.querySelector<HTMLElement>(
              `[data-myoxus-ui-role="workspace-home-task-row"][data-task-id="${CSS.escape(rowId)}"]`,
            )
          : null;
      const target =
        row ??
        (creationFocus ? newTaskRef.current : null) ??
        openTasksRef.current;
      if (!target) return;
      target.focus({ preventScroll: true });
      params.delete("focus");
      params.delete("taskReturnScroll");
      if (rowFocus) params.delete("returnRowId");
      const search = params.toString();
      view.replace({ ...home, search: search ? `?${search}` : "" });
      view.setScrollPosition(position);
    },
    [isActiveView, scrollViewport, view],
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => restoreHomeReturn());
    return () => cancelAnimationFrame(frame);
  }, [location.key, restoreHomeReturn]);
  const taskPreviewReady = useCallback(() => {
    const current = view.location$.value;
    const focus = new URLSearchParams(current.search).get("focus");
    if (
      current.key === location.key &&
      (focus === TASK_HOME_ROW_RETURN_FOCUS ||
        focus === TASK_CREATION_RETURN_FOCUS)
    )
      restoreHomeReturn(true);
  }, [location.key, restoreHomeReturn, view]);
  const dashboardProjection = useLiveData(
    preferences.workspaceDashboardLayouts$,
  );
  const preferenceError = useLiveData(preferences.error$);
  const [editMode, setEditMode] = useState(false);
  const [focusFirstDashletRevision, setFocusFirstDashletRevision] = useState(0);
  const [online, setOnline] = useState(
    () => globalThis.navigator?.onLine ?? true,
  );
  const workspaceName = useLiveData(workspace.name$) || t["Untitled"]();
  const ordinaryDocuments$ = useMemo(
    () =>
      LiveData.from(
        collectionRules.watch({
          filters: [
            { type: "system", key: "template", method: "is", value: "false" },
          ],
        }),
        undefined,
      ),
    [collectionRules],
  );
  const documents$ = useMemo(
    () =>
      LiveData.computed((get) => {
        const current = get(docsService.list.docsMap$);
        for (const record of current.values()) {
          get(record.meta$);
          get(record.journalDate$);
          get(record.primaryMode$);
        }
        const ordinary = new Set(
          get(ordinaryDocuments$)?.groups.flatMap((group) => group.items) ?? [],
        );
        return createDashboardDocumentSnapshots(current).filter((document) =>
          ordinary.has(document.id),
        );
      }),
    [docsService, ordinaryDocuments$],
  );
  const documents = useLiveData(documents$);
  const ordinaryDocuments = useLiveData(ordinaryDocuments$);
  const documentError =
    workspace.flavour !== "local" &&
    metadataIndex.phase === "error" &&
    metadataIndex.rows.length === 0;
  const documentsLoading = ordinaryDocuments == null && !documentError;
  const retryDocuments = useCallback(() => {
    documentMetadataCache.invalidateIndex("home-retry");
    void documentMetadataCache.hydrateIndex().catch(() => {
      // The existing index state owns the error and visible retry surface.
    });
  }, [documentMetadataCache]);
  const { newDocuments, recentlyEdited } = useMemo(
    () => projectDashboardDocuments(documents),
    [documents],
  );
  const openAll = useCallback(
    () => workbench.open("/all", { at: "active" }),
    [workbench],
  );
  const openReminderHistory = useCallback(
    () => workbench.open("/inbox?read=all&type=reminders", { at: "active" }),
    [workbench],
  );
  const openActivity = useCallback(
    () => workbench.open("/inbox?read=unread&type=all", { at: "active" }),
    [workbench],
  );
  const serverBacked = workspace.flavour !== "local";
  const persistedLayout =
    dashboardProjection.projected?.find(
      (layout) => layout.workspaceId === workspace.id,
    ) ?? null;
  const resolvedLayout = useMemo(
    () => resolveWorkspaceDashboardLayout(persistedLayout),
    [persistedLayout],
  );
  const [draftLayout, setDraftLayout] = useState(resolvedLayout);

  useEffect(() => {
    if (!editMode) setDraftLayout(resolvedLayout);
  }, [editMode, resolvedLayout]);

  useEffect(() => {
    const update = () => setOnline(globalThis.navigator?.onLine ?? true);
    globalThis.addEventListener?.("online", update);
    globalThis.addEventListener?.("offline", update);
    return () => {
      globalThis.removeEventListener?.("online", update);
      globalThis.removeEventListener?.("offline", update);
    };
  }, []);

  const persistLayout = useCallback(
    async (next = draftLayout) => {
      notify.dismiss(dashboardSavedNotificationId);
      await preferences.updateWorkspaceDashboardLayout(
        toWorkspaceDashboardLayout(workspace.id, next),
      );
      if (!preferences.error$.value) {
        notify.success(
          {
            title: t["com.myoxus.database.view.saved"](),
          },
          { id: dashboardSavedNotificationId },
        );
      }
    },
    [draftLayout, preferences, t, workspace.id],
  );
  const moveDashlet = useCallback(
    (
      dashletId: Parameters<typeof moveDashboardDashlet>[1],
      targetIndex: number,
      persist: boolean,
    ) => {
      const next = moveDashboardDashlet(
        editMode ? draftLayout : resolvedLayout,
        dashletId,
        targetIndex,
      );
      setDraftLayout(next);
      if (persist) void persistLayout(next);
    },
    [draftLayout, editMode, persistLayout, resolvedLayout],
  );
  const resizeDashlet = useCallback(
    (
      dashletId: Parameters<typeof resizeDashboardDashlet>[1],
      size: Parameters<typeof resizeDashboardDashlet>[2],
    ) => {
      const next = resizeDashboardDashlet(draftLayout, dashletId, size);
      setDraftLayout(next);
      void persistLayout(next);
    },
    [draftLayout, persistLayout],
  );
  const resetLayout = useCallback(async () => {
    const previous = preferences.getWorkspaceDashboardLayout(workspace.id);
    if (!previous) return;
    notify.dismiss(dashboardSavedNotificationId);
    const defaults = resolveWorkspaceDashboardLayout(null);
    setDraftLayout(defaults);
    await preferences.resetWorkspaceDashboardLayout(workspace.id);
    notify.success({
      title: t["com.myoxus.settings.workspace.documents.action.reset"](),
      actions: [
        {
          key: "workspace-dashboard-layout-undo",
          label: t["Undo"](),
          onClick: async () => {
            setDraftLayout(resolveWorkspaceDashboardLayout(previous));
            await preferences.updateWorkspaceDashboardLayout(previous);
            setFocusFirstDashletRevision((revision) => revision + 1);
          },
        },
      ],
    });
  }, [preferences, t, workspace.id]);
  const dashletLabels = {
    today: t["com.myoxus.today"](),
    tasks: t["com.myoxus.database.tasks.mine"](),
    "new-documents": t["com.myoxus.workspace-home.new-documents"](),
    reminders: t["com.myoxus.notification.filter.reminders"](),
    "recently-edited": t["com.myoxus.diagrams.catalog.recent"](),
    activity: t["com.myoxus.sidebar.tab.activity"](),
  } as const;
  const saveStatus =
    dashboardProjection.syncStatus === "pending"
      ? !online
        ? "offline"
        : preferenceError
          ? "error"
          : "saving"
      : null;
  const visibleLayout = editMode ? draftLayout : resolvedLayout;

  return (
    <>
      <ViewTitle title={t["com.myoxus.workspace-home.title"]()} />
      <ViewIcon icon="home" />
      <ViewHeader>
        <WorkspaceHomeHeader
          canCustomize={serverBacked}
          canReset={Boolean(persistedLayout)}
          editMode={editMode}
          onEdit={() => {
            setDraftLayout(resolvedLayout);
            setEditMode(true);
          }}
          onFinish={() => setEditMode(false)}
          onOpenAll={openAll}
          onReset={() => void resetLayout()}
          onRetry={() => void preferences.sync()}
          saveStatus={saveStatus}
        />
      </ViewHeader>
      <ViewBody>
        <PageContentRail
          fill
          scroll
          spacious
          width="data"
          data-myoxus-ui-role="workspace-home-content"
        >
          <Stack gap="lg" w="100%">
            <Stack gap="xs">
              <MyoxusTitle order={1} typographySlot="page-title">
                {t["com.myoxus.workspace-home.title"]()}
              </MyoxusTitle>
              <MyoxusText tone="secondary">
                {t["com.myoxus.workspace-home.description"]({
                  workspace: workspaceName,
                })}
              </MyoxusText>
            </Stack>
            <WorkspaceHomeAssistance
              server={workspaceServer}
              workspaceId={workspace.id}
              local={workspace.flavour === "local"}
              state={globalState}
              onNewTask={() => openTasks(undefined, undefined, true)}
              onOpenNotes={openAll}
              onOpenLibrary={() =>
                workbench.open("/templates", { at: "active" })
              }
            />
            <DashboardGrid
              childrenById={{
                today: <TodaySection />,
                tasks: serverBacked ? (
                  <DashboardTaskSection
                    size={visibleLayout.dashletSizes.tasks}
                    onOpenTasks={() => openTasks()}
                    onOpenTask={(databaseId, rowId) =>
                      openTasks(databaseId, rowId)
                    }
                    onNewTask={() => openTasks(undefined, undefined, true)}
                    newTaskRef={newTaskRef}
                    openTasksRef={openTasksRef}
                    onPreviewReady={taskPreviewReady}
                  />
                ) : (
                  <DashboardSectionUnavailable kind="tasks" />
                ),
                "new-documents": (
                  <DashboardDocumentSection
                    documents={newDocuments.slice(
                      0,
                      getDashboardDocumentLimit(
                        visibleLayout.dashletSizes["new-documents"],
                      ),
                    )}
                    kind="new"
                    loading={documentsLoading}
                    error={documentError}
                    onRetry={retryDocuments}
                    onOpenAll={openAll}
                    workspaceName={workspaceName}
                  />
                ),
                reminders: serverBacked ? (
                  <DashboardNotificationSection
                    kind="reminders"
                    onOpenInbox={openReminderHistory}
                  />
                ) : (
                  <DashboardSectionUnavailable kind="reminders" />
                ),
                "recently-edited": (
                  <DashboardDocumentSection
                    documents={recentlyEdited.slice(
                      0,
                      getDashboardDocumentLimit(
                        visibleLayout.dashletSizes["recently-edited"],
                      ),
                    )}
                    kind="recent"
                    loading={documentsLoading}
                    error={documentError}
                    onRetry={retryDocuments}
                    onOpenAll={openAll}
                    workspaceName={workspaceName}
                  />
                ),
                activity: serverBacked ? (
                  <DashboardNotificationSection
                    kind="activity"
                    onOpenInbox={openActivity}
                  />
                ) : (
                  <DashboardSectionUnavailable kind="activity" />
                ),
              }}
              editMode={editMode}
              focusFirstDashletRevision={focusFirstDashletRevision}
              labels={dashletLabels}
              layout={visibleLayout}
              onCommit={() => void persistLayout()}
              onMove={moveDashlet}
              onResize={resizeDashlet}
            />
          </Stack>
        </PageContentRail>
      </ViewBody>
    </>
  );
};

const DashboardSectionUnavailable = ({
  kind,
}: {
  kind: "activity" | "reminders" | "tasks";
}) => {
  const t = useI18n();
  const title =
    kind === "tasks"
      ? t["com.myoxus.database.progress.tasks"]()
      : kind === "activity"
        ? t["com.myoxus.sidebar.tab.activity"]()
        : t["com.myoxus.notification.filter.reminders"]();
  return (
    <DashboardSection
      icon={
        kind === "tasks" ? (
          <ListChecksIcon />
        ) : (
          <DashboardNotificationIcon kind={kind} />
        )
      }
      title={title}
      uiRole="workspace-home-server-data-unavailable"
    >
      <MyoxusText textAlign="center" tone="secondary">
        {t["com.myoxus.workspace-home.server-data-unavailable"]()}
      </MyoxusText>
    </DashboardSection>
  );
};

export const Component = WorkspaceHomePage;
