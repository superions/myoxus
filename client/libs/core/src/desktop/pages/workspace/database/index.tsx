// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  UserPreferencesService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";

import { databaseManagedCapabilities } from "@myoxus/core/modules/database/managed";
import { useTaskIdentity } from "@myoxus/core/modules/database/tasks/use-workspace-tasks";

import {
  useMutateQueryResource,
  useMutation,
} from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  classifyDatabaseError,
  DatabaseConflictProvider,
  type DatabaseChangeInput,
  type DatabaseRecord,
  type DatabaseView,
  type DatabaseRouteStatus,
  databaseScheduleWindow,
  DatabaseViewHost,
  getDatabaseDetailRouteStatus,
  getDatabaseUnavailableWorkspaceRouteStatus,
  getDatabaseWorkspaceAvailability,
  databaseScheduleFieldsValid,
  getPrimaryViewOrNull,
  inflateDatabaseViewSummary,
  openDatabaseDialogAfterMenuClose,
  useDatabaseConflictController,
  useDatabaseImportController,
  WORKSPACE_DATABASE_PAGE_SIZE,
} from "@myoxus/core/modules/database";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { RecentWorkspaceItemsService } from "@myoxus/core/modules/quicksearch";
import { GraphQLService } from "@myoxus/core/modules/server";
import {
  useIsActiveView,
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
  ViewService,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { DatabasePagesService } from "@myoxus/core/modules/workspace-pages";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import {
  DatabaseCsvDelimiter,
  type DatabaseCsvDialectInput,
  databaseCsvExportQuery,
  DatabaseCsvExportTarget,
  databaseJsonExportQuery,
  databaseRowQuery,
  databaseRowsQuery,
  databaseRowTemplatesQuery,
  databaseSchemaQuery,
  DatabaseViewKind,
  databaseViewQuery,
  databaseViewsQuery,
  projectSetupQuery,
  trashDatabaseMutation,
  updateDatabaseMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  EmptyState,
  EmptyStateTitle,
  FormRow,
  FormSelect,
  Group,
  InlineEdit,
  type InlineEditHandle,
  Input,
  Loading,
  Modal,
  MyoxusText,
  notify,
  PageContentRail,
  Pagination,
  Stack,
  Textarea,
  useConfirmModal,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "react-router";
import useSWR from "swr";

import { getDatabasePath } from "../../../route-paths";
import { invalidateDatabaseChangeQueries } from "./change-invalidation";
import { DatabaseTaskOwnerBoundary } from "./task-owner-boundary";
import { DatabaseHeaderMenuButton } from "./header-menu";
import {
  type DatabaseRowsConnection,
  type DatabaseScheduleWindowConnection,
  loadScheduleWindowRows,
} from "./schedule-window-rows";

function downloadDatabaseExport(
  fileName: string,
  contentType: string,
  content: string,
) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

const WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG = {
  // These routes render their own GraphQL failure states; Suspense would throw
  // query errors into the Workbench boundary before the P4 route state can run.
  suspense: false,
  suppressErrorNotification: true,
} as const;

function DatabaseDetailRouteState({
  status,
  databaseTitle,
  onRetry,
}: {
  status: Exclude<DatabaseRouteStatus, "ready">;
  databaseTitle?: string;
  onRetry?: () => void;
}) {
  const t = useI18n();
  const title =
    status === "loading"
      ? t["com.myoxus.database.embed.loading"]()
      : status === "local-unavailable"
        ? t["com.myoxus.database.server-backed-only.title"]()
        : status === "missing"
          ? t["com.myoxus.database.detail.missing"]()
          : status === "forbidden"
            ? t["com.myoxus.database.embed.forbidden"]()
            : status === "offline"
              ? t["com.myoxus.database.embed.offline"]()
              : t["com.myoxus.database.embed.unavailable"]();
  const canRetry =
    Boolean(onRetry) && (status === "offline" || status === "unavailable");

  return (
    <>
      <ViewTitle title={databaseTitle ?? title} />
      <ViewIcon icon="collection" />
      {databaseTitle ? (
        <ViewHeader>
          <WorkbenchHeaderFrame
            left={<DatabaseIcon />}
            title={
              <WorkbenchHeaderContextPath
                parents={[t["com.myoxus.database.index.title"]()]}
                current={databaseTitle}
              />
            }
          />
        </ViewHeader>
      ) : null}
      <ViewBody>
        <PageContentRail centerContent fill width="data">
          {status === "loading" ? (
            <Loading />
          ) : (
            <EmptyState
              title={
                <EmptyStateTitle icon={<DatabaseIcon />}>
                  {title}
                </EmptyStateTitle>
              }
              cta={
                canRetry ? (
                  <Button onClick={onRetry}>{t["Retry"]()}</Button>
                ) : undefined
              }
              data-testid={`database-detail-${status}`}
            />
          )}
        </PageContentRail>
      </ViewBody>
    </>
  );
}

type I18nShape = ReturnType<typeof useI18n>;

const CSV_EXPORT_DELIMITERS = [
  DatabaseCsvDelimiter.Comma,
  DatabaseCsvDelimiter.Semicolon,
  DatabaseCsvDelimiter.Tab,
  DatabaseCsvDelimiter.Pipe,
  DatabaseCsvDelimiter.Custom,
] as const;

function defaultExportDialect(): DatabaseCsvDialectInput {
  return {
    delimiter: DatabaseCsvDelimiter.Comma,
    doubleQuote: true,
  };
}

function exportDialectForInput(
  dialect: DatabaseCsvDialectInput,
): DatabaseCsvDialectInput {
  const customDelimiter = dialect.customDelimiter?.trim();
  return {
    delimiter: dialect.delimiter,
    customDelimiter:
      dialect.delimiter === DatabaseCsvDelimiter.Custom && customDelimiter
        ? customDelimiter
        : null,
    quote: dialect.quote?.trim() || null,
    escape: dialect.escape?.trim() || null,
    doubleQuote: dialect.doubleQuote ?? true,
  };
}

function csvDelimiterLabel(t: I18nShape, delimiter: DatabaseCsvDelimiter) {
  switch (delimiter) {
    case DatabaseCsvDelimiter.Comma:
      return t["com.myoxus.database.csv.delimiter.comma"]();
    case DatabaseCsvDelimiter.Semicolon:
      return t["com.myoxus.database.csv.delimiter.semicolon"]();
    case DatabaseCsvDelimiter.Tab:
      return t["com.myoxus.database.csv.delimiter.tab"]();
    case DatabaseCsvDelimiter.Pipe:
      return t["com.myoxus.database.csv.delimiter.pipe"]();
    case DatabaseCsvDelimiter.Custom:
      return t["com.myoxus.database.csv.delimiter.custom"]();
    default:
      return delimiter;
  }
}

const DatabasePageContent = ({
  ownerAdmissionPending = false,
}: {
  ownerAdmissionPending?: boolean;
}) => {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const { openConfirmModal } = useConfirmModal();
  const { databaseId } = useParams<{ databaseId: string }>();
  const workspace = useService(WorkspaceService).workspace;
  const workspaceServer = useLiveData(
    workspace.scope.get(WorkspaceServerService).server$,
  );
  const availability = getDatabaseWorkspaceAvailability(workspace);
  const workspaceId = availability.serverWorkspaceId;
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const graphqlService = useService(GraphQLService);
  const databasePagesService = useService(DatabasePagesService);
  const globalContext = useService(GlobalContextService).globalContext;
  const recentWorkspaceItems = useService(RecentWorkspaceItemsService);
  const isActiveView = useIsActiveView();
  const revalidate = useMutateQueryResource();
  const [searchParams] = useSearchParams();
  const setupOwner = useTaskIdentity();
  const setupRequestId = searchParams.get("projectSetup");
  const { data: setupData } = useSWR(
    workspaceId && setupRequestId && setupOwner.identity && setupOwner.server
      ? [
          "project-setup-result",
          setupOwner.identity,
          workspaceId,
          setupRequestId,
        ]
      : null,
    () =>
      setupOwner.server!.gql({
        query: projectSetupQuery,
        variables: { workspaceId: workspaceId!, requestId: setupRequestId! },
      }),
    { suspense: false, keepPreviousData: false },
  );
  // The route carries only a request selector. Native readback supplies current
  // access and exact acknowledged IDs; another account's cached result cannot
  // become an Open command on this Project.
  const setupDocuments = useMemo(() => {
    const setup = setupData?.workspace?.projectSetup;
    if (
      !setup ||
      setupData.currentUser?.id !== setupOwner.account?.id ||
      setupData.workspace?.id !== workspaceId ||
      setup.reservedDatabaseId !== databaseId ||
      setup.database?.database.id !== databaseId
    )
      return [];
    return setup.documents.flatMap((document) => {
      const source = setup.acceptedPlan.documents.find(
        (source) => source.source.componentId === document.componentId,
      );
      return document.created &&
        document.placed &&
        document.externalId &&
        source
        ? [
            {
              componentId: document.componentId,
              title: source.title,
              externalId: document.externalId,
            },
          ]
        : [];
    });
  }, [setupData, setupOwner.account?.id, workspaceId, databaseId]);
  const routeViewId = searchParams.get("viewId");
  const routeRowId = searchParams.get("rowId");
  const [rowPage, setRowPage] = useState(0);
  const [rowSearch, setRowSearch] = useState("");
  const [scheduleDate, setScheduleDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const deferredRowSearch = useDeferredValue(rowSearch);
  const [activeViewId, setActiveViewId] = useState<string | null>(
    () => routeViewId,
  );
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const titleEditRef = useRef<InlineEditHandle>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewTitle, setOverviewTitle] = useState("");
  const [overviewDescription, setOverviewDescription] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"csv" | "json">("csv");
  const [exportDialect, setExportDialect] = useState<DatabaseCsvDialectInput>(
    () => defaultExportDialect(),
  );
  const updateDatabase = useMutation({
    mutation: updateDatabaseMutation,
  });
  const trashDatabase = useMutation({
    mutation: trashDatabaseMutation,
  });

  if (!databaseId) {
    throw new Error("Database route is missing databaseId.");
  }

  const {
    data: databaseSchemaData,
    error: databaseSchemaError,
    isLoading: isDatabaseSchemaLoading,
  } = useQuery(
    workspaceId
      ? {
          query: databaseSchemaQuery,
          variables: { workspaceId, databaseId },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const {
    data: databaseViewsData,
    error: databaseViewsError,
    isLoading: isDatabaseViewsLoading,
  } = useQuery(
    workspaceId
      ? {
          query: databaseViewsQuery,
          variables: { workspaceId, databaseId },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const schemaRecord = databaseSchemaData?.workspace?.database;
  const viewsRecord = databaseViewsData?.workspace?.database;
  const summaryViews = useMemo(
    () => viewsRecord?.views.map(inflateDatabaseViewSummary) ?? [],
    [viewsRecord],
  );
  const summaryRecord =
    schemaRecord && viewsRecord
      ? {
          ...schemaRecord,
          views: summaryViews,
        }
      : undefined;
  const activeViewSummary = summaryRecord
    ? getPrimaryViewOrNull(summaryRecord, activeViewId)
    : null;
  const {
    data: databaseViewData,
    error: databaseViewError,
    isLoading: isDatabaseViewLoading,
  } = useQuery(
    workspaceId && activeViewSummary
      ? {
          query: databaseViewQuery,
          variables: {
            workspaceId,
            databaseId,
            viewId: activeViewSummary.id,
          },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const activeViewRecord = databaseViewData?.workspace?.databaseView ?? null;
  const record = useMemo(
    () =>
      schemaRecord && viewsRecord && activeViewRecord
        ? ({
            ...schemaRecord,
            views: summaryViews.map((view) =>
              view.id === activeViewRecord.id ? activeViewRecord : view,
            ),
          } as DatabaseRecord)
        : undefined,
    [activeViewRecord, schemaRecord, summaryViews, viewsRecord],
  );
  const activeView = record ? getPrimaryViewOrNull(record, activeViewId) : null;
  const scheduleWindow =
    activeView &&
    (![DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
      activeView.viewKind,
    ) ||
      (record &&
        databaseScheduleFieldsValid(
          record,
          activeView.viewKind === DatabaseViewKind.Timeline
            ? activeView.config.timeline?.startFieldId
            : activeView.config.gantt?.startFieldId,
          activeView.viewKind === DatabaseViewKind.Timeline
            ? activeView.config.timeline?.endFieldId
            : activeView.config.gantt?.endFieldId,
        )))
      ? databaseScheduleWindow(activeView, scheduleDate, t.language)
      : null;
  const isScheduleView =
    activeView?.viewKind === DatabaseViewKind.Calendar ||
    activeView?.viewKind === DatabaseViewKind.Gantt ||
    activeView?.viewKind === DatabaseViewKind.Timeline;
  const {
    data: rowData,
    error: rowError,
    isLoading: isRowsLoading,
  } = useQuery(
    workspaceId && activeView && !isScheduleView
      ? {
          query: databaseRowsQuery,
          variables: {
            workspaceId,
            databaseId,
            first: WORKSPACE_DATABASE_PAGE_SIZE,
            offset: rowPage * WORKSPACE_DATABASE_PAGE_SIZE,
            search:
              activeView.viewKind === DatabaseViewKind.Table
                ? deferredRowSearch.trim() || null
                : null,
            scheduleWindow,
            viewId: activeView.id,
          },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const scheduleRows = useScheduleWindowRows({
    view: activeView,
    date: scheduleDate,
    locale: t.language,
    active: isScheduleView,
    grouped:
      activeView?.viewKind === DatabaseViewKind.Gantt &&
      Boolean(activeView.config.gantt?.group),
    databaseId,
    editRevision: activeView?.editRevision ?? 0,
    scheduleWindowEnd: scheduleWindow?.end ?? null,
    scheduleWindowEndFieldId: scheduleWindow?.endFieldId ?? null,
    scheduleWindowFieldId: scheduleWindow?.fieldId ?? null,
    scheduleWindowStart: scheduleWindow?.start ?? null,
    search: deferredRowSearch.trim() || null,
    viewId: activeView?.id ?? null,
    workspaceId,
  });
  const rowsConnection = isScheduleView
    ? scheduleRows.connection
    : rowData?.workspace?.databaseRows;
  const effectiveRowError = isScheduleView ? scheduleRows.error : rowError;
  const effectiveRowsLoading = isScheduleView
    ? scheduleRows.isLoading
    : isRowsLoading;
  const {
    data: linkedRowData,
    error: linkedRowError,
    isLoading: isLinkedRowLoading,
  } = useQuery(
    workspaceId && routeRowId
      ? {
          query: databaseRowQuery,
          variables: { workspaceId, databaseId, rowId: routeRowId },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const { data: rowTemplateData } = useQuery(
    workspaceId
      ? {
          query: databaseRowTemplatesQuery,
          variables: { workspaceId, databaseId },
        }
      : undefined,
    WORKSPACE_DATABASE_ROUTE_QUERY_CONFIG,
  );
  const routeStatus =
    availability.status === "available"
      ? getDatabaseDetailRouteStatus({
          databaseDataLoaded: Boolean(
            databaseSchemaData &&
            databaseViewsData &&
            (!activeViewSummary || databaseViewData),
          ),
          databaseError:
            databaseSchemaError ?? databaseViewsError ?? databaseViewError,
          hasActiveView: Boolean(activeView),
          hasDatabase: Boolean(record),
          hasRowsConnection: Boolean(rowsConnection),
          hasWorkspace: Boolean(
            databaseSchemaData?.workspace && databaseViewsData?.workspace,
          ),
          // A schedule readback keeps the last complete server snapshot mounted.
          // Query errors still replace the route; refreshing must not destroy
          // an opening-revision draft or its durable focus target.
          isDatabaseLoading:
            !(
              activeView &&
              [DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                activeView.viewKind,
              ) &&
              record
            ) &&
            (isDatabaseSchemaLoading ||
              isDatabaseViewsLoading ||
              Boolean(activeViewSummary && isDatabaseViewLoading)),
          isRowsLoading:
            effectiveRowsLoading &&
            !(
              activeView &&
              [DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                activeView.viewKind,
              ) &&
              rowsConnection
            ),
          rowDataLoaded: Boolean(rowsConnection),
          rowError:
            isScheduleView &&
            rowsConnection &&
            effectiveRowError &&
            ["offline", "unavailable"].includes(
              classifyDatabaseError(effectiveRowError),
            )
              ? undefined
              : effectiveRowError,
        })
      : getDatabaseUnavailableWorkspaceRouteStatus({
          reason: availability.reason,
        });
  const linkedRowErrorKind = linkedRowError
    ? classifyDatabaseError(linkedRowError)
    : null;
  const linkedRow = linkedRowData?.workspace?.databaseRow;
  const linkedRowLoadState = routeRowId
    ? linkedRowErrorKind === "forbidden" || linkedRow?.redacted
      ? ("forbidden" as const)
      : linkedRowErrorKind === "missing" || linkedRow?.row.deletedAt
        ? ("missing" as const)
        : isLinkedRowLoading
          ? ("loading" as const)
          : linkedRowError
            ? ("unavailable" as const)
            : linkedRow
              ? null
              : ("missing" as const)
    : null;
  const linkedRowTerminal =
    linkedRowLoadState === "forbidden" || linkedRowLoadState === "missing";
  const rows = useMemo(() => {
    if (routeStatus !== "ready") return [];
    // A terminal linked-Row read must not be undone by a slower inventory page.
    // Transient failures retain its last complete same-owner projection.
    const pageRows = linkedRowTerminal
      ? (rowsConnection?.rows ?? []).filter(
          (entry) => entry.row.id !== routeRowId,
        )
      : (rowsConnection?.rows ?? []);
    if (
      linkedRowTerminal ||
      !linkedRow ||
      pageRows.some(
        (entry: DatabaseRowsConnection["rows"][number]) =>
          entry.row.id === linkedRow.row.id,
      )
    ) {
      return pageRows;
    }
    return [...pageRows, linkedRow];
  }, [linkedRow, linkedRowTerminal, routeRowId, routeStatus, rowsConnection]);
  const rowTotalCount = rowsConnection?.totalCount ?? record?.rowCount ?? 0;
  const rowTemplates = rowTemplateData?.workspace?.databaseRowTemplates ?? [];
  const isResolvedDatabaseRoute =
    routeStatus === "ready" && Boolean(record && activeView && workspaceId);

  useEffect(() => {
    if (isResolvedDatabaseRoute) {
      recentWorkspaceItems.addRecentDatabase(databaseId);
    }
  }, [databaseId, isResolvedDatabaseRoute, recentWorkspaceItems]);

  useEffect(() => {
    setActiveViewId(routeViewId);
    setRowPage(0);
  }, [databaseId, routeViewId]);

  useEffect(() => {
    if (!isActiveView) return;
    globalContext.databaseId.set(databaseId);
    globalContext.isDatabase.set(true);
    return () => {
      globalContext.databaseId.set(null);
      globalContext.isDatabase.set(false);
    };
  }, [databaseId, globalContext, isActiveView]);

  useEffect(() => {
    setRowPage(0);
  }, [activeView?.id, databaseId]);

  const selectActiveView = useCallback(
    (viewId: string | null) => {
      setActiveViewId(viewId);
      setRowPage(0);
      const location = workbench.location$.value;
      const nextSearchParams = new URLSearchParams(location.search);
      if (viewId) nextSearchParams.set("viewId", viewId);
      else nextSearchParams.delete("viewId");
      const search = nextSearchParams.toString();
      // Database pages run inside the Workbench MemoryRouter. Writing the
      // owning View history lets the existing browser adapter keep the nested
      // route and the canonical browser URL in lockstep.
      workbench.open(
        {
          hash: location.hash,
          pathname: location.pathname,
          search: search ? `?${search}` : "",
        },
        { at: "active", replaceHistory: true },
      );
    },
    [workbench],
  );

  const selectActiveRow = useCallback(
    (rowId: string | null) => {
      const location = view.location$.value;
      const nextSearchParams = new URLSearchParams(location.search);
      if (rowId) nextSearchParams.set("rowId", rowId);
      else nextSearchParams.delete("rowId");
      const search = nextSearchParams.toString();
      // A dirty-editor Apply can finish after another pane becomes active.
      view.replace({
        hash: location.hash,
        pathname: location.pathname,
        search: search ? `?${search}` : "",
      });
    },
    [view],
  );

  useEffect(() => {
    if (!activeView || routeViewId === activeView.id) return;
    selectActiveView(activeView.id);
  }, [activeView, routeViewId, selectActiveView]);

  const openImportedDatabase = useCallback(
    (importedDatabaseId: string, importedViewId: string | null) => {
      const search = importedViewId
        ? `?${new URLSearchParams({ viewId: importedViewId })}`
        : "";
      workbench.open(`/databases/${importedDatabaseId}${search}`, {
        at: "active",
        replaceHistory: true,
      });
    },
    [workbench],
  );
  const databaseImport = useDatabaseImportController({
    workspaceId,
    targetDatabaseId:
      schemaRecord && databaseManagedCapabilities(schemaRecord).managed
        ? databaseId
        : undefined,
    targetDatabaseTitle: schemaRecord
      ? databaseManagedCapabilities(schemaRecord).workspaceTasks
        ? t["com.myoxus.database.tasks.workspace-tasks"]()
        : schemaRecord.database.title
      : undefined,
    onImported: openImportedDatabase,
    onApplied: async () => {
      databasePagesService.invalidate();
      if (schemaRecord && databaseManagedCapabilities(schemaRecord).managed)
        await refresh({ kind: "bulk_imported" });
    },
  });

  const copyViewLink = useCallback(
    async (viewId: string) => {
      if (!workspaceId) return false;
      const url = new URL(
        getDatabasePath(workspaceId, databaseId),
        window.location.origin,
      );
      url.searchParams.set("viewId", viewId);
      return copyTextToClipboard(url.toString());
    },
    [databaseId, workspaceId],
  );

  const copyRowLink = useCallback(
    async (rowId: string, viewId: string) => {
      if (!workspaceId) return false;
      const url = new URL(
        getDatabasePath(workspaceId, databaseId),
        window.location.origin,
      );
      url.searchParams.set("viewId", viewId);
      url.searchParams.set("rowId", rowId);
      return copyTextToClipboard(url.toString());
    },
    [databaseId, workspaceId],
  );

  const refresh = useCallback(
    async (reason?: DatabaseChangeInput) => {
      if (!workspaceId) return;
      await invalidateDatabaseChangeQueries({
        databaseId,
        reason,
        refreshScheduleRows: scheduleRows.reload,
        revalidate,
        workspaceId,
      });
    },
    [databaseId, revalidate, scheduleRows.reload, workspaceId],
  );

  const refreshRemoteChange = useCallback(
    async (event: DatabaseChangeInput) => {
      await refresh(event);
    },
    [refresh],
  );

  const openDoc = useCallback(
    (docId: string) => {
      workbench.openDoc(docId, { at: "new-tab" });
    },
    [workbench],
  );

  const renameDatabase = useCallback(
    async (title: string) => {
      const database = record?.database;
      const trimmed = title.trim();
      if (!database || !trimmed || trimmed === database.title) return;
      await conflicts.execute({
        attemptedAction: t["Rename"](),
        localValue: trimmed,
        reloadLatest: () => refresh(),
        afterSuccess: async () => {
          databasePagesService.invalidate();
          await refresh({ kind: "database_updated" });
        },
        mutate: (force) =>
          updateDatabase.trigger({
            input: {
              databaseId,
              title: trimmed,
              expectedEditRevision: database.editRevision,
              force,
            },
          }),
      });
    },
    [
      conflicts,
      databaseId,
      databasePagesService,
      record,
      refresh,
      t,
      updateDatabase,
    ],
  );

  const openRename = useCallback(() => {
    setHeaderMenuOpen(false);
    openDatabaseDialogAfterMenuClose(() => titleEditRef.current?.triggerEdit());
  }, []);

  const openOverview = useCallback(() => {
    if (!record) return;
    setHeaderMenuOpen(false);
    openDatabaseDialogAfterMenuClose(() => {
      setOverviewTitle(record.database.title);
      setOverviewDescription(record.database.description ?? "");
      setOverviewOpen(true);
    });
  }, [record]);

  const saveOverview = useCallback(async () => {
    const database = record?.database;
    const title = overviewTitle.trim();
    const description = overviewDescription.trim() || null;
    if (!database || !title) return;
    if (
      title === database.title &&
      description === (database.description?.trim() || null)
    ) {
      setOverviewOpen(false);
      return;
    }
    await conflicts.execute({
      attemptedAction: t["com.myoxus.database.overview.edit"](),
      localValue: { title, description },
      reloadLatest: async () => {
        setOverviewOpen(false);
        await refresh();
      },
      afterSuccess: async () => {
        setOverviewOpen(false);
        databasePagesService.invalidate();
        await refresh({ kind: "database_updated" });
      },
      mutate: (force) =>
        updateDatabase.trigger({
          input: {
            databaseId,
            title,
            description,
            expectedEditRevision: database.editRevision,
            force,
          },
        }),
    });
  }, [
    conflicts,
    databaseId,
    databasePagesService,
    overviewDescription,
    overviewTitle,
    record,
    refresh,
    t,
    updateDatabase,
  ]);

  const copyDatabaseLink = useCallback(async () => {
    if (!workspaceId) return;
    const copied = await copyTextToClipboard(
      new URL(
        getDatabasePath(workspaceId, databaseId),
        window.location.origin,
      ).toString(),
    );
    if (copied) {
      notify.success({ title: t["Copied link to clipboard"]() });
    } else {
      notify.error({
        title: t["com.myoxus.database.view.copy-link-failed"](),
      });
    }
  }, [databaseId, t, workspaceId]);

  const openExport = useCallback((format: "csv" | "json") => {
    setHeaderMenuOpen(false);
    openDatabaseDialogAfterMenuClose(() => {
      setExportFormat(format);
      setExportOpen(true);
    });
  }, []);

  const confirmTrashDatabase = useCallback(() => {
    const database = record?.database;
    if (!database || !workspaceId) return;
    setHeaderMenuOpen(false);
    openDatabaseDialogAfterMenuClose(() => {
      openConfirmModal({
        title: t["com.myoxus.moveToTrash.title"](),
        description: t["com.myoxus.moveToTrash.confirmModal.description"]({
          title: database.title,
        }),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.moveToTrash.title"](),
        confirmButtonOptions: { variant: "error" },
        returnFocusRef: headerMenuTriggerRef,
        onConfirm: async () => {
          await conflicts.execute({
            attemptedAction: t["com.myoxus.moveToTrash.title"](),
            localValue: database.title,
            reloadLatest: refresh,
            afterSuccess: async () => {
              databasePagesService.invalidate();
              await refresh({ kind: "database_trashed" });
              workbench.open("/databases", {
                at: "active",
                replaceHistory: true,
              });
            },
            mutate: (force) =>
              trashDatabase.trigger({
                input: {
                  databaseId,
                  expectedEditRevision: database.editRevision,
                  force,
                },
              }),
          });
        },
      });
    });
  }, [
    conflicts,
    databaseId,
    databasePagesService,
    trashDatabase,
    openConfirmModal,
    record,
    refresh,
    t,
    workbench,
    workspaceId,
  ]);

  const exportCsv = useCallback(
    async (rowIds?: string[]) => {
      if (!workspaceId) return;
      const response = await graphqlService.gql({
        query: databaseCsvExportQuery,
        variables: {
          workspaceId,
          databaseId,
          options: {
            dialect: exportDialectForInput(exportDialect),
            target: rowIds?.length
              ? DatabaseCsvExportTarget.SelectedRows
              : DatabaseCsvExportTarget.View,
            viewId: activeView?.id ?? null,
            rowIds: rowIds?.length ? rowIds : null,
          },
        },
      });
      const result = response.workspace?.databaseCsvExport;
      if (!result) return;
      downloadDatabaseExport(
        result.fileName,
        result.contentType,
        result.content,
      );
      setExportOpen(false);
    },
    [activeView?.id, databaseId, exportDialect, graphqlService, workspaceId],
  );

  const exportJson = useCallback(async () => {
    if (!workspaceId) return;
    const response = await graphqlService.gql({
      query: databaseJsonExportQuery,
      variables: {
        workspaceId,
        databaseId,
      },
    });
    const result = response.workspace?.databaseJsonExport;
    if (!result) return;
    downloadDatabaseExport(result.fileName, result.contentType, result.content);
    setExportOpen(false);
  }, [databaseId, graphqlService, workspaceId]);

  if (routeStatus !== "ready") {
    return (
      <DatabaseDetailRouteState
        status={routeStatus}
        databaseTitle={schemaRecord?.database.title}
        onRetry={refresh}
      />
    );
  }
  if (!record || !activeView || !workspaceId) {
    return <DatabaseDetailRouteState status="unavailable" />;
  }

  return (
    <>
      <ViewTitle
        title={
          databaseManagedCapabilities(record).workspaceTasks
            ? t["com.myoxus.database.progress.tasks"]()
            : record.database.title
        }
      />
      <ViewIcon icon="collection" />
      <ViewBody>
        <PageContentRail fill scroll width="data">
          <DatabaseViewHost
            activeViewId={activeView.id}
            databaseId={databaseId}
            initialRowId={routeRowId}
            initialRowLoadState={linkedRowLoadState}
            ownerAdmissionPending={ownerAdmissionPending}
            layout="page"
            onActiveViewChange={selectActiveView}
            onChanged={refresh}
            onCopyRowLink={copyRowLink}
            onCopyViewLink={copyViewLink}
            onExportCsvRows={(rowIds) => exportCsv(rowIds)}
            onOpenDoc={openDoc}
            onRemoteChange={refreshRemoteChange}
            onRowDetailChange={selectActiveRow}
            onScheduleChanged={refresh}
            assistanceReturnFocusRef={headerMenuTriggerRef}
            renderPageHeader={(navigation, assistanceItems) => (
              <ViewHeader>
                <WorkbenchHeaderFrame
                  left={navigation}
                  title={
                    <WorkbenchHeaderContextPath
                      parents={
                        databaseManagedCapabilities(record).workspaceTasks
                          ? []
                          : [t["com.myoxus.database.index.title"]()]
                      }
                      current={
                        <InlineEdit
                          handleRef={titleEditRef}
                          editable={
                            databaseManagedCapabilities(record).canEditMetadata
                          }
                          trigger="doubleClick"
                          value={
                            databaseManagedCapabilities(record).workspaceTasks
                              ? t["com.myoxus.database.progress.tasks"]()
                              : record.database.title
                          }
                          onChange={(title) => void renameDatabase(title)}
                        />
                      }
                    />
                  }
                  right={
                    <DatabaseHeaderMenuButton
                      ref={headerMenuTriggerRef}
                      contextualAssistance={assistanceItems}
                      setupDocuments={setupDocuments}
                      onOpenSetupDocument={openDoc}
                      assistance={
                        workspaceId &&
                        databaseManagedCapabilities(record).managed &&
                        databaseManagedCapabilities(record).ready &&
                        !databaseManagedCapabilities(record).workspaceTasks &&
                        workspaceServer
                          ? {
                              service: workspaceServer.scope.get(
                                UserPreferencesService,
                              ),
                              workspaceId,
                              projectId: record.database.id,
                            }
                          : undefined
                      }
                      contentImportOnly={
                        databaseManagedCapabilities(record).managed
                      }
                      canImportContent={
                        databaseManagedCapabilities(record).ready
                      }
                      canEditMetadata={
                        databaseManagedCapabilities(record).canEditMetadata
                      }
                      canManageLifecycle={
                        databaseManagedCapabilities(record).canManageLifecycle
                      }
                      csvBusy={databaseImport.csvBusy}
                      jsonBusy={databaseImport.jsonBusy}
                      notionBusy={databaseImport.notionBusy}
                      open={headerMenuOpen}
                      onOpenChange={setHeaderMenuOpen}
                      onRename={openRename}
                      onEditOverview={openOverview}
                      onCopyLink={() => void copyDatabaseLink()}
                      onImportCsv={databaseImport.openCsvPicker}
                      onImportJson={databaseImport.openJsonPicker}
                      onImportNotion={databaseImport.openNotionPicker}
                      onExportCsv={() => openExport("csv")}
                      onExportJson={() => openExport("json")}
                      onTrash={confirmTrashDatabase}
                    />
                  }
                />
              </ViewHeader>
            )}
            onScheduleDateChange={(date) => {
              setScheduleDate(date);
              setRowPage(0);
            }}
            onSearchChange={(value) => {
              setRowSearch(value);
              setRowPage(0);
            }}
            pagination={
              !isScheduleView &&
              rowTotalCount > WORKSPACE_DATABASE_PAGE_SIZE ? (
                <Pagination
                  totalCount={rowTotalCount}
                  pageNum={rowPage}
                  countPerPage={WORKSPACE_DATABASE_PAGE_SIZE}
                  onPageChange={(_, nextPage) => setRowPage(nextPage)}
                  withEdges
                />
              ) : null
            }
            record={record}
            rowTemplates={rowTemplates}
            rows={rows}
            rowGroups={scheduleRows.connection?.groups}
            rowsLoading={effectiveRowsLoading}
            rowsError={
              effectiveRowError
                ? classifyDatabaseError(effectiveRowError) === "offline"
                  ? "offline"
                  : "unavailable"
                : undefined
            }
            onRowsRetry={() =>
              void scheduleRows.reload().catch(() =>
                notify.error({
                  title: t["com.myoxus.common.operation-failed"](),
                }),
              )
            }
            rowsScheduleDate={scheduleRows.date}
            rowsScheduleView={scheduleRows.view}
            scheduleDate={scheduleDate}
            search={rowSearch}
            workspaceId={workspaceId}
          />
        </PageContentRail>
      </ViewBody>
      {databaseImport.surfaces}
      <Modal
        open={overviewOpen}
        onOpenChange={setOverviewOpen}
        title={t["com.myoxus.database.overview.edit"]()}
        returnFocusRef={headerMenuTriggerRef}
        contentOptions={{ "data-testid": "database-overview-modal" }}
      >
        <Stack gap="md">
          <FormRow label={t["com.myoxus.database.overview.title"]()}>
            <Input
              aria-label={t["com.myoxus.database.overview.title"]()}
              block
              autoFocus
              value={overviewTitle}
              onChange={setOverviewTitle}
            />
          </FormRow>
          <FormRow label={t["com.myoxus.common.description"]()}>
            <Textarea
              aria-label={t["com.myoxus.common.description"]()}
              value={overviewDescription}
              onChange={setOverviewDescription}
            />
          </FormRow>
          <Group justify="end" gap="xs">
            <Button variant="secondary" onClick={() => setOverviewOpen(false)}>
              {t["Cancel"]()}
            </Button>
            <Button
              loading={updateDatabase.isMutating}
              disabled={!overviewTitle.trim()}
              onClick={() => void saveOverview()}
            >
              {t["Save"]()}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        open={exportOpen}
        onOpenChange={setExportOpen}
        title={t["com.myoxus.database.export.title"]()}
        scrollable
        returnFocusRef={headerMenuTriggerRef}
        contentOptions={{ "data-testid": "database-export-modal" }}
      >
        <Stack gap="md">
          <MyoxusText tone="secondary">
            {t["com.myoxus.database.export.description"]()}
          </MyoxusText>
          <FormRow label={t["com.myoxus.database.export.format"]()}>
            <FormSelect
              aria-label={t["com.myoxus.database.export.format"]()}
              value={exportFormat}
              data={[
                {
                  value: "csv",
                  label: t["com.myoxus.database.export.format.csv"](),
                },
                {
                  value: "json",
                  label: t["com.myoxus.database.export.format.json"](),
                },
              ]}
              onChange={(format) =>
                setExportFormat(format === "json" ? "json" : "csv")
              }
            />
          </FormRow>
          {exportFormat === "csv" ? (
            <>
              <FormRow label={t["com.myoxus.database.csv.delimiter"]()}>
                <FormSelect
                  aria-label={t["com.myoxus.database.csv.delimiter"]()}
                  value={exportDialect.delimiter}
                  data={CSV_EXPORT_DELIMITERS.map((delimiter) => ({
                    value: delimiter,
                    label: csvDelimiterLabel(t, delimiter),
                  }))}
                  onChange={(delimiter) =>
                    setExportDialect((current) => ({
                      ...current,
                      delimiter: delimiter as DatabaseCsvDelimiter,
                    }))
                  }
                />
              </FormRow>
              {exportDialect.delimiter === DatabaseCsvDelimiter.Custom ? (
                <FormRow
                  label={t["com.myoxus.database.csv.delimiter.custom"]()}
                >
                  <Input
                    aria-label={t["com.myoxus.database.csv.delimiter.custom"]()}
                    block
                    value={exportDialect.customDelimiter ?? ""}
                    onChange={(customDelimiter) =>
                      setExportDialect((current) => ({
                        ...current,
                        customDelimiter,
                      }))
                    }
                  />
                </FormRow>
              ) : null}
            </>
          ) : (
            <MyoxusText tone="secondary">
              {t["com.myoxus.database.json-export.description"]()}
            </MyoxusText>
          )}
          <Group justify="end" gap="xs">
            <Button variant="secondary" onClick={() => setExportOpen(false)}>
              {t["Cancel"]()}
            </Button>
            <Button
              onClick={() =>
                void (exportFormat === "json" ? exportJson() : exportCsv())
              }
              disabled={
                exportFormat === "csv" &&
                exportDialect.delimiter === DatabaseCsvDelimiter.Custom &&
                !exportDialect.customDelimiter?.trim()
              }
            >
              {t["com.myoxus.database.export.download"]()}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
};

function useScheduleWindowRows({
  view,
  date,
  locale,
  active,
  grouped,
  databaseId,
  editRevision,
  scheduleWindowEnd,
  scheduleWindowEndFieldId,
  scheduleWindowFieldId,
  scheduleWindowStart,
  search,
  viewId,
  workspaceId,
}: {
  view: DatabaseView | null;
  date: string;
  locale: string;
  active: boolean;
  grouped: boolean;
  databaseId: string;
  editRevision: number;
  scheduleWindowEnd: string | null;
  scheduleWindowEndFieldId: string | null;
  scheduleWindowFieldId: string | null;
  scheduleWindowStart: string | null;
  search: string | null;
  viewId: string | null;
  workspaceId: string | null;
}) {
  const graphqlService = useService(GraphQLService);
  const [state, setState] = useState<{
    connection?: DatabaseScheduleWindowConnection;
    date?: string;
    view?: DatabaseView | null;
    error?: unknown;
    isLoading: boolean;
  }>({ isLoading: false });
  const [reloadRevision, setReloadRevision] = useState(0);
  const requestedReadbackRevision = useRef(0);
  const readbackWaiters = useRef<
    Array<{
      revision: number;
      resolve: () => void;
      reject: (error: unknown) => void;
    }>
  >([]);
  const reload = useCallback(
    () =>
      !active
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const revision = ++requestedReadbackRevision.current;
            readbackWaiters.current.push({ revision, resolve, reject });
            setReloadRevision(revision);
          }),
    [active],
  );
  const settleReadback = useCallback((revision: number, error?: unknown) => {
    const waiters = readbackWaiters.current.filter(
      (waiter) => waiter.revision <= revision,
    );
    readbackWaiters.current = readbackWaiters.current.filter(
      (waiter) => waiter.revision > revision,
    );
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }, []);
  useEffect(
    () => () => {
      settleReadback(Infinity, new Error("Database schedule consumer closed."));
    },
    [settleReadback],
  );

  useEffect(() => {
    if (!active) {
      // Deep-link changes briefly leave the active View unresolved. Keep both
      // the last complete page and its readback waiters until the new View is
      // resolved; a normal View creation must not reject its own readback.
      // Non-schedule Views are read back by the ordinary Rows query instead.
      if (view) settleReadback(reloadRevision);
      return;
    }
    if (
      !workspaceId ||
      !viewId ||
      !scheduleWindowEnd ||
      !scheduleWindowFieldId ||
      !scheduleWindowStart
    ) {
      setState({
        connection: { endCursor: null, rows: [], totalCount: 0 },
        date,
        view,
        isLoading: false,
      });
      settleReadback(reloadRevision);
      return;
    }

    const controller = new AbortController();
    setState((current) => ({
      ...current,
      error: undefined,
      isLoading: true,
    }));
    void loadScheduleWindowRows({
      locale,
      grouped,
      graphqlService,
      pageSize: WORKSPACE_DATABASE_PAGE_SIZE,
      signal: controller.signal,
      variables: {
        databaseId,
        filter: null,
        filterTree: null,
        scheduleWindow: {
          end: scheduleWindowEnd,
          endFieldId: scheduleWindowEndFieldId,
          fieldId: scheduleWindowFieldId,
          start: scheduleWindowStart,
        },
        search,
        sort: null,
        viewId,
        workspaceId,
      },
    }).then(
      (connection) => {
        if (!controller.signal.aborted) {
          setState({ connection, date, view, isLoading: false });
          settleReadback(reloadRevision);
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState((current) => ({ ...current, error, isLoading: false }));
          settleReadback(reloadRevision, error);
        }
      },
    );
    return () => controller.abort();
  }, [
    active,
    date,
    databaseId,
    editRevision,
    graphqlService,
    grouped,
    locale,
    reloadRevision,
    settleReadback,
    scheduleWindowEnd,
    scheduleWindowEndFieldId,
    scheduleWindowFieldId,
    scheduleWindowStart,
    search,
    view,
    viewId,
    workspaceId,
  ]);

  return { ...state, reload };
}

export const DatabasePage = () => (
  <DatabaseConflictProvider>
    <DatabaseTaskOwnerBoundary
      renderState={(status, onRetry) => (
        <DatabaseDetailRouteState status={status} onRetry={onRetry} />
      )}
    >
      {(ownerAdmissionPending) => (
        <DatabasePageContent ownerAdmissionPending={ownerAdmissionPending} />
      )}
    </DatabaseTaskOwnerBoundary>
  </DatabaseConflictProvider>
);

export const Component = () => <DatabasePage />;
