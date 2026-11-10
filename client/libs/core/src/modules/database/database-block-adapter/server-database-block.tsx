// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseContainerReference } from "./database-container-reference";
import { TaskRowReference } from "./task-row-reference";
import { resolveTaskReferenceScope } from "./task-reference-scope";

import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { getDatabaseWorkspaceAvailability } from "../availability";
import {
  getPrimaryViewOrNull,
  inflateDatabaseViewSummary,
  WORKSPACE_DATABASE_PAGE_SIZE,
} from "../model";
import { classifyDatabaseError } from "../route-state";
import {
  type DatabaseChangeInput,
  type DatabaseChangeReason,
  databaseChangeImpact,
} from "../shared/change-invalidation";
import { databaseScheduleFieldsValid } from "../shared/date-source";
import { databaseScheduleWindow } from "../shared/schedule";
import {
  type DatabaseScheduleWindowConnection,
  loadScheduleWindowRows,
} from "../shared/schedule-window-rows";
import type {
  DatabaseRecord,
  DatabaseView,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
} from "../types";
import { loadDatabaseViewHost } from "./load-view-host";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import {
  type DatabaseRowGroupSummaryFragment,
  databaseRowsQuery,
  databaseRowTemplatesQuery,
  databaseSchemaQuery,
  DatabaseViewKind,
  databaseViewQuery,
  databaseViewsQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon, OpenInNewIcon } from "@myoxus/icons/react";
import { type FrameworkProvider, FrameworkRoot } from "@myoxus/infra";
import {
  Button,
  Group,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { MyoxusEmbeddedUIProvider } from "@myoxus/ui-facade/provider";
import type { DatabaseReferenceBlockModel } from "@virgultum/block-database/reference-store";
import { html } from "lit";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";

type ServerDatabaseEmbedState =
  | { status: "loading" }
  | {
      status:
        | "missing"
        | "forbidden"
        | "local-unavailable"
        | "offline"
        | "unavailable";
    }
  | {
      status: "ready";
      record: DatabaseRecord;
      rowTemplates: DatabaseRowTemplateBinding[];
      rows: DatabaseRowRecord[];
      rowGroups?: DatabaseRowGroupSummaryFragment[];
      rowsError?: "offline" | "unavailable";
      rowsLoading: boolean;
      rowsSearch: string | null;
      rowsScheduleDate: string | null;
      rowsScheduleView: DatabaseView | null;
      viewId: string;
    };

type DatabaseEmbedProps = {
  databaseId: string;
  framework?: FrameworkProvider;
  viewId?: string | null;
  workspaceFlavour?: string | null;
  workspaceId: string;
};

function useServerDatabaseEmbed({
  databaseId,
  framework,
  viewId,
  workspaceFlavour,
  workspaceId,
}: DatabaseEmbedProps) {
  const [state, setState] = useState<ServerDatabaseEmbedState>({
    status: "loading",
  });
  const t = useI18n();
  const [search, setSearch] = useState("");
  const [scheduleDate, setScheduleDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const deferredSearch = useDeferredValue(search);
  // Structure, selected View and Rows have separate abort scopes so narrow
  // invalidation cannot cancel or replace a newer result from another family.
  const scopeGeneration = useRef(0);
  const structureController = useRef<AbortController | undefined>(undefined);
  const viewController = useRef<AbortController | undefined>(undefined);
  const rowsController = useRef<AbortController | undefined>(undefined);
  const summaryRecord = useRef<DatabaseRecord | undefined>(undefined);
  const rowTemplates = useRef<DatabaseRowTemplateBinding[]>([]);
  const loadingViewId = useRef<string | undefined>(undefined);
  const loadingSearch = useRef<string | undefined>(undefined);
  const loadingScheduleDate = useRef<string | undefined>(undefined);
  const requestedScheduleDate = useRef(scheduleDate);
  const requestedViewId = useRef(viewId);
  const requestedSearch = useRef(deferredSearch);
  const stateRef = useRef(state);
  stateRef.current = state;
  requestedViewId.current = viewId;
  requestedSearch.current = deferredSearch;
  requestedScheduleDate.current = scheduleDate;

  const resolveScope = useCallback(() => {
    if (!framework || !databaseId || !workspaceId) return null;
    const workspace =
      framework.get(WorkspaceService).workspace ??
      ({ flavour: workspaceFlavour, id: workspaceId } as const);
    const availability = getDatabaseWorkspaceAvailability(workspace);
    if (availability.status !== "available") {
      setState({
        status:
          availability.reason === "local-workspace"
            ? "local-unavailable"
            : "unavailable",
      });
      return null;
    }
    return {
      graphQLService: framework.get(GraphQLService),
      serverWorkspaceId: availability.serverWorkspaceId,
    };
  }, [databaseId, framework, workspaceFlavour, workspaceId]);

  const loadRows = useCallback(
    async (
      record: DatabaseRecord,
      activeViewId: string,
      generation: number,
      searchValue: string,
    ) => {
      const scope = resolveScope();
      const activeView = getPrimaryViewOrNull(record, activeViewId);
      if (!scope || !activeView) {
        if (generation === scopeGeneration.current) {
          setState({ status: "missing" });
        }
        return;
      }

      rowsController.current?.abort();
      const controller = new AbortController();
      rowsController.current = controller;
      const dateValue = requestedScheduleDate.current;
      loadingSearch.current = searchValue;
      loadingScheduleDate.current = dateValue;
      setState((current) =>
        current.status === "ready" && current.record === record
          ? { ...current, rowsError: undefined, rowsLoading: true }
          : current,
      );
      try {
        const isScheduleView =
          activeView.viewKind === DatabaseViewKind.Calendar ||
          activeView.viewKind === DatabaseViewKind.Gantt ||
          activeView.viewKind === DatabaseViewKind.Timeline;
        const rowsResponse: DatabaseScheduleWindowConnection | undefined =
          [DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
            activeView.viewKind,
          ) &&
          !databaseScheduleFieldsValid(
            record,
            activeView.viewKind === DatabaseViewKind.Timeline
              ? activeView.config.timeline?.startFieldId
              : activeView.config.gantt?.startFieldId,
            activeView.viewKind === DatabaseViewKind.Timeline
              ? activeView.config.timeline?.endFieldId
              : activeView.config.gantt?.endFieldId,
          )
            ? // Invalid configuration is repaired through schedule Fields settings;
              // querying an unknown field would replace that recovery with unavailable.
              { endCursor: null, rows: [], totalCount: 0 }
            : isScheduleView
              ? await loadScheduleWindowRows({
                  locale: t.language,
                  grouped:
                    activeView.viewKind === DatabaseViewKind.Gantt &&
                    Boolean(activeView.config.gantt?.group),
                  graphqlService: scope.graphQLService,
                  pageSize: WORKSPACE_DATABASE_PAGE_SIZE,
                  signal: controller.signal,
                  variables: {
                    workspaceId: scope.serverWorkspaceId,
                    databaseId,
                    viewId: activeView.id,
                    filter: null,
                    filterTree: null,
                    scheduleWindow: databaseScheduleWindow(
                      activeView,
                      dateValue,
                      t.language,
                    ),
                    search: searchValue.trim() || null,
                    sort: null,
                  },
                })
              : (
                  await scope.graphQLService.gql({
                    query: databaseRowsQuery,
                    variables: {
                      workspaceId: scope.serverWorkspaceId,
                      databaseId,
                      viewId: activeView.id,
                      first: WORKSPACE_DATABASE_PAGE_SIZE,
                      offset: 0,
                      search:
                        activeView.viewKind === DatabaseViewKind.Table
                          ? searchValue.trim() || null
                          : null,
                    },
                    signal: controller.signal,
                  })
                ).workspace?.databaseRows;
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        setState((current) =>
          current.status === "ready" && current.record === record
            ? {
                ...current,
                rows: rowsResponse?.rows ?? [],
                rowGroups: rowsResponse?.groups,
                rowsError: undefined,
                rowsLoading: false,
                rowsSearch: searchValue,
                rowsScheduleDate: dateValue,
                rowsScheduleView: activeView,
              }
            : current,
        );
        if (rowsController.current === controller) {
          loadingSearch.current = undefined;
          loadingScheduleDate.current = undefined;
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        loadingSearch.current = undefined;
        loadingScheduleDate.current = undefined;
        const status = classifyDatabaseError(error);
        if (
          status === "forbidden" ||
          status === "missing" ||
          status === "local-unavailable"
        ) {
          setState({ status });
          return;
        }
        setState((current) =>
          current.status === "ready" && current.record === record
            ? {
                ...current,
                rowsError: status,
                rowsLoading: false,
              }
            : { status },
        );
      }
    },
    [databaseId, resolveScope, t.language],
  );

  const loadView = useCallback(
    async (generation: number, selectedViewId?: string | null) => {
      const scope = resolveScope();
      const summaries = summaryRecord.current;
      if (!scope || !summaries) return;
      const activeViewSummary = getPrimaryViewOrNull(summaries, selectedViewId);
      if (!activeViewSummary) {
        setState({ status: "missing" });
        return;
      }

      viewController.current?.abort();
      rowsController.current?.abort();
      const controller = new AbortController();
      viewController.current = controller;
      loadingViewId.current = activeViewSummary.id;
      setState((current) =>
        current.status === "ready"
          ? { ...current, rowsLoading: true }
          : current,
      );
      try {
        const response = await scope.graphQLService.gql({
          query: databaseViewQuery,
          variables: {
            workspaceId: scope.serverWorkspaceId,
            databaseId,
            viewId: activeViewSummary.id,
          },
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        const activeViewRecord = response.workspace?.databaseView;
        if (!activeViewRecord) {
          setState({ status: "missing" });
          return;
        }
        const record: DatabaseRecord = {
          ...summaries,
          views: summaries.views.map((candidate) =>
            candidate.id === activeViewRecord.id ? activeViewRecord : candidate,
          ),
        };
        loadingViewId.current = undefined;
        setState({
          status: "ready",
          record,
          rowTemplates: rowTemplates.current,
          rows: [],
          rowsError: undefined,
          rowsLoading: true,
          rowsSearch: null,
          rowsScheduleDate: null,
          rowsScheduleView: null,
          viewId: activeViewRecord.id,
        });
        await loadRows(
          record,
          activeViewRecord.id,
          generation,
          requestedSearch.current,
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        loadingViewId.current = undefined;
        const status = classifyDatabaseError(error);
        if (
          status === "forbidden" ||
          status === "missing" ||
          status === "local-unavailable"
        ) {
          setState({ status });
          return;
        }
        setState((current) =>
          current.status === "ready"
            ? {
                ...current,
                rows: [],
                rowsError: status,
                rowsLoading: false,
              }
            : { status },
        );
      }
    },
    [databaseId, loadRows, resolveScope],
  );

  const loadStructure = useCallback(
    async (generation: number) => {
      const scope = resolveScope();
      if (!scope) return;
      structureController.current?.abort();
      viewController.current?.abort();
      rowsController.current?.abort();
      const controller = new AbortController();
      structureController.current = controller;
      try {
        const [schemaResponse, viewsResponse, templatesResponse] =
          await Promise.all([
            scope.graphQLService.gql({
              query: databaseSchemaQuery,
              variables: {
                workspaceId: scope.serverWorkspaceId,
                databaseId,
              },
              signal: controller.signal,
            }),
            scope.graphQLService.gql({
              query: databaseViewsQuery,
              variables: {
                workspaceId: scope.serverWorkspaceId,
                databaseId,
              },
              signal: controller.signal,
            }),
            scope.graphQLService.gql({
              query: databaseRowTemplatesQuery,
              variables: {
                workspaceId: scope.serverWorkspaceId,
                databaseId,
              },
              signal: controller.signal,
            }),
          ]);
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        const schema = schemaResponse.workspace?.database;
        const views = viewsResponse.workspace?.database;
        if (!schema || !views) {
          setState({ status: "missing" });
          return;
        }
        summaryRecord.current = {
          ...schema,
          views: views.views.map(inflateDatabaseViewSummary),
        } as DatabaseRecord;
        rowTemplates.current =
          templatesResponse.workspace?.databaseRowTemplates ?? [];
        await loadView(generation, requestedViewId.current);
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        const status = classifyDatabaseError(error);
        if (
          status === "forbidden" ||
          status === "missing" ||
          status === "local-unavailable"
        ) {
          setState({ status });
          return;
        }
        setState((current) =>
          current.status === "ready"
            ? {
                ...current,
                rows: [],
                rowsError: status,
                rowsLoading: false,
              }
            : { status },
        );
      }
    },
    [databaseId, loadView, resolveScope],
  );

  useEffect(() => {
    const generation = scopeGeneration.current + 1;
    scopeGeneration.current = generation;
    summaryRecord.current = undefined;
    rowTemplates.current = [];
    loadingViewId.current = undefined;
    loadingSearch.current = undefined;
    setState({ status: "loading" });
    void loadStructure(generation);
    return () => {
      structureController.current?.abort();
      viewController.current?.abort();
      rowsController.current?.abort();
    };
  }, [databaseId, framework, loadStructure, workspaceId]);

  useEffect(() => {
    if (!summaryRecord.current) return;
    const currentViewId = state.status === "ready" ? state.viewId : undefined;
    const nextViewId = getPrimaryViewOrNull(summaryRecord.current, viewId)?.id;
    if (
      !nextViewId ||
      nextViewId === currentViewId ||
      nextViewId === loadingViewId.current
    ) {
      return;
    }
    void loadView(scopeGeneration.current, nextViewId);
  }, [loadView, state, viewId]);

  useEffect(() => {
    if (
      state.status !== "ready" ||
      loadingViewId.current ||
      (state.rowsSearch === deferredSearch &&
        state.rowsScheduleDate === scheduleDate) ||
      (loadingSearch.current === deferredSearch &&
        loadingScheduleDate.current === scheduleDate)
    ) {
      return;
    }
    void loadRows(
      state.record,
      state.viewId,
      scopeGeneration.current,
      deferredSearch,
    );
  }, [deferredSearch, loadRows, scheduleDate, state]);

  const refresh = useCallback(
    async (reason?: DatabaseChangeInput) => {
      const impact = databaseChangeImpact(
        reason ?? ({ kind: "full_reload" } satisfies DatabaseChangeReason),
      );
      const generation = scopeGeneration.current;
      const current = stateRef.current;
      if (current.status !== "ready" || !summaryRecord.current) {
        await loadStructure(generation);
        return;
      }
      if (
        impact.schema &&
        impact.viewSummaries &&
        impact.activeView &&
        impact.rowTemplates &&
        impact.rows
      ) {
        await loadStructure(generation);
        return;
      }
      if (
        !impact.schema &&
        !impact.viewSummaries &&
        !impact.activeView &&
        !impact.rowTemplates &&
        !impact.rows &&
        !impact.scheduleRows
      ) {
        return;
      }
      if (
        !impact.schema &&
        !impact.viewSummaries &&
        !impact.activeView &&
        !impact.rowTemplates
      ) {
        await loadRows(
          current.record,
          current.viewId,
          generation,
          requestedSearch.current,
        );
        return;
      }

      const scope = resolveScope();
      if (!scope) return;
      structureController.current?.abort();
      if (impact.schema || impact.viewSummaries || impact.activeView) {
        viewController.current?.abort();
        rowsController.current?.abort();
      }
      const controller = new AbortController();
      structureController.current = controller;
      try {
        let summaries = summaryRecord.current;
        if (impact.schema) {
          const response = await scope.graphQLService.gql({
            query: databaseSchemaQuery,
            variables: {
              workspaceId: scope.serverWorkspaceId,
              databaseId,
            },
            signal: controller.signal,
          });
          const schema = response.workspace?.database;
          if (!schema) {
            setState({ status: "missing" });
            return;
          }
          summaries = { ...schema, views: summaries.views } as DatabaseRecord;
        }
        if (impact.viewSummaries) {
          const response = await scope.graphQLService.gql({
            query: databaseViewsQuery,
            variables: {
              workspaceId: scope.serverWorkspaceId,
              databaseId,
            },
            signal: controller.signal,
          });
          const views = response.workspace?.database;
          if (!views) {
            setState({ status: "missing" });
            return;
          }
          summaries = {
            ...summaries,
            views: views.views.map(inflateDatabaseViewSummary),
          };
        }
        if (impact.rowTemplates) {
          const response = await scope.graphQLService.gql({
            query: databaseRowTemplatesQuery,
            variables: {
              workspaceId: scope.serverWorkspaceId,
              databaseId,
            },
            signal: controller.signal,
          });
          rowTemplates.current = response.workspace?.databaseRowTemplates ?? [];
        }
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        summaryRecord.current = summaries;
        if (
          impact.rowTemplates &&
          !impact.schema &&
          !impact.viewSummaries &&
          !impact.activeView &&
          !impact.rows &&
          !impact.scheduleRows
        ) {
          setState((latest) =>
            latest.status === "ready"
              ? { ...latest, rowTemplates: rowTemplates.current }
              : latest,
          );
          return;
        }
        if (impact.activeView) {
          await loadView(generation, current.viewId);
          return;
        }

        const detailedView = getPrimaryViewOrNull(
          current.record,
          current.viewId,
        );
        const nextView = getPrimaryViewOrNull(summaries, current.viewId);
        if (!detailedView || !nextView) {
          await loadView(generation, requestedViewId.current);
          return;
        }
        const record: DatabaseRecord = {
          ...summaries,
          views: summaries.views.map((candidate) =>
            candidate.id === detailedView.id ? detailedView : candidate,
          ),
        };
        setState((latest) =>
          latest.status === "ready" && latest.viewId === current.viewId
            ? {
                ...latest,
                record,
                rowTemplates: rowTemplates.current,
                rowsError: undefined,
              }
            : latest,
        );
        if (impact.rows || impact.scheduleRows) {
          await loadRows(
            record,
            current.viewId,
            generation,
            requestedSearch.current,
          );
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          generation !== scopeGeneration.current
        ) {
          return;
        }
        const status = classifyDatabaseError(error);
        if (
          status === "forbidden" ||
          status === "missing" ||
          status === "local-unavailable"
        ) {
          setState({ status });
          return;
        }
        setState((latest) =>
          latest.status === "ready"
            ? {
                ...latest,
                rows: [],
                rowsError: status,
                rowsLoading: false,
              }
            : { status },
        );
      }
    },
    [databaseId, loadRows, loadStructure, loadView, resolveScope],
  );
  const exposedState =
    state.status === "ready" &&
    (search !== deferredSearch || state.rowsScheduleDate !== scheduleDate)
      ? { ...state, rowsLoading: true }
      : state;
  return {
    refresh,
    scheduleDate,
    search,
    setScheduleDate,
    setSearch,
    state: exposedState,
  };
}

function DatabaseEmbedMessage({
  onRetry,
  status,
}: {
  onRetry?: () => void;
  status: Exclude<ServerDatabaseEmbedState["status"], "ready">;
}) {
  const t = useI18n();
  const title =
    status === "loading"
      ? t["com.myoxus.database.embed.loading"]()
      : status === "missing"
        ? t["com.myoxus.database.embed.not-found"]()
        : status === "forbidden"
          ? t["com.myoxus.database.embed.forbidden"]()
          : status === "local-unavailable"
            ? t["com.myoxus.database.server-backed-only.title"]()
            : status === "offline"
              ? t["com.myoxus.database.embed.offline"]()
              : t["com.myoxus.database.embed.unavailable"]();

  return (
    <SurfaceListItem
      appearance="card"
      layout="row"
      alignItems="center"
      data-testid={`database-embed-${status}`}
    >
      <DatabaseIcon />
      <SurfaceListItemMain>
        <SurfaceListText kind="card-title" component="span">
          {title}
        </SurfaceListText>
      </SurfaceListItemMain>
      {onRetry && (status === "offline" || status === "unavailable") ? (
        <Button variant="secondary" onClick={onRetry}>
          {t["Retry"]()}
        </Button>
      ) : null}
    </SurfaceListItem>
  );
}

export function DatabaseEmbed({
  databaseId,
  framework,
  viewId,
  workspaceFlavour,
  workspaceId,
}: DatabaseEmbedProps) {
  const t = useI18n();
  const [ViewHost, setViewHost] =
    useState<typeof import("../view-host").DatabaseViewHost>();
  const [viewLoadFailed, setViewLoadFailed] = useState(false);
  const [viewAttempt, setViewAttempt] = useState(0);
  const [activeViewId, setActiveViewId] = useState<string | null>(
    viewId ?? null,
  );
  const { refresh, scheduleDate, search, setScheduleDate, setSearch, state } =
    useServerDatabaseEmbed({
      databaseId,
      framework,
      viewId: activeViewId,
      workspaceFlavour,
      workspaceId,
    });

  useEffect(() => {
    setActiveViewId(viewId ?? null);
  }, [databaseId, viewId]);

  useEffect(() => {
    if (state.status !== "ready" || ViewHost) return;
    // Only a permitted, materialized embed needs the optional view runtime.
    // Disposal fences this mount without cancelling another embed's import.
    let active = true;
    setViewLoadFailed(false);
    void loadDatabaseViewHost()
      .then((host) => {
        if (active) setViewHost(() => host);
      })
      .catch(() => {
        if (active) setViewLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [state.status, ViewHost, viewAttempt]);

  if (state.status !== "ready") {
    return (
      <DatabaseEmbedMessage
        onRetry={() => void refresh()}
        status={state.status}
      />
    );
  }

  if (!ViewHost) {
    return (
      <DatabaseEmbedMessage
        status={viewLoadFailed ? "unavailable" : "loading"}
        onRetry={
          viewLoadFailed
            ? () => setViewAttempt((attempt) => attempt + 1)
            : undefined
        }
      />
    );
  }

  const { record } = state;
  const openDatabase = () => {
    framework
      ?.get(WorkbenchService)
      .workbench.open(`/databases/${databaseId}`, {
        at: "new-tab",
      });
  };

  return (
    <SurfaceListItem
      appearance="card"
      layout="column"
      data-testid="database-view-host-embed"
    >
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs" wrap="nowrap">
          <DatabaseIcon />
          <SurfaceListItemMain>
            <SurfaceListText kind="card-title" component="span">
              {record.database.title}
            </SurfaceListText>
          </SurfaceListItemMain>
        </Group>
        <Button
          prefix={<OpenInNewIcon />}
          variant="secondary"
          onClick={openDatabase}
        >
          {t["com.myoxus.database.embed.open"]()}
        </Button>
      </Group>
      <ViewHost
        activeViewId={state.viewId}
        databaseId={databaseId}
        layout="embedded"
        onActiveViewChange={setActiveViewId}
        onChanged={refresh}
        onRemoteChange={refresh}
        onRowsRetry={() => void refresh()}
        onSearchChange={setSearch}
        onScheduleDateChange={setScheduleDate}
        onScheduleChanged={refresh}
        onOpenDoc={(docId) =>
          framework?.get(WorkbenchService).workbench.openDoc(docId, {
            at: "new-tab",
          })
        }
        record={record}
        rowTemplates={state.rowTemplates}
        rows={state.rows}
        rowGroups={state.rowGroups}
        rowsError={state.rowsError}
        rowsLoading={state.rowsLoading}
        rowsScheduleDate={state.rowsScheduleDate}
        rowsScheduleView={state.rowsScheduleView}
        search={search}
        scheduleDate={scheduleDate}
        workspaceId={workspaceId}
      />
    </SurfaceListItem>
  );
}

let databaseEmbedThemeRoot = 0;

class DatabaseEmbedElement extends HTMLElement {
  private readonly themeRootId = String(++databaseEmbedThemeRoot);
  private readonly cssVariablesSelector = `[data-myoxus-database-react-root="${this.themeRootId}"]`;
  private connectionRevision = 0;
  private root?: Root;
  private frameworkValue?: FrameworkProvider;
  private themeObserver?: MutationObserver;
  private themeScope?: Element;
  private readonly getMantineRootElement = () => this;

  static get observedAttributes() {
    return [
      "database-id",
      "view-id",
      "workspace-flavour",
      "workspace-id",
      "row-id",
      "reference-mode",
      "readonly",
    ];
  }

  set framework(framework: FrameworkProvider | undefined) {
    this.frameworkValue = framework;
    this.renderReact();
  }

  connectedCallback() {
    this.connectionRevision += 1;
    this.observeThemeScope();
    this.renderReact();
  }

  disconnectedCallback() {
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.themeScope = undefined;
    const revision = ++this.connectionRevision;
    queueMicrotask(() => {
      if (this.isConnected || revision !== this.connectionRevision) return;
      this.root?.unmount();
      this.root = undefined;
    });
  }

  attributeChangedCallback() {
    this.renderReact();
  }

  private renderReact() {
    if (!this.isConnected) return;
    // Color-scheme context alone cannot rebind inherited Mantine role values.
    // Materialize the existing Facade projection against this renderer's tokens.
    this.setAttribute("data-myoxus-database-react-root", this.themeRootId);
    this.observeThemeScope();
    this.root ??= createRoot(this);
    const content = (
      <MyoxusEmbeddedUIProvider
        colorScheme={resolveEmbeddedColorScheme(this)}
        cssVariablesSelector={this.cssVariablesSelector}
        getRootElement={this.getMantineRootElement}
      >
        {this.getAttribute("reference-mode") === "unavailable" ? (
          <DatabaseEmbedMessage status="unavailable" />
        ) : this.getAttribute("reference-mode") === "container" ? (
          this.frameworkValue ? (
            <DatabaseContainerReference
              framework={this.frameworkValue}
              workspaceId={this.getAttribute("workspace-id") ?? ""}
              databaseId={this.getAttribute("database-id") ?? ""}
            />
          ) : (
            <DatabaseEmbedMessage status="unavailable" />
          )
        ) : this.getAttribute("reference-mode") === "task" ? (
          this.frameworkValue ? (
            <TaskRowReference
              framework={this.frameworkValue}
              readonly={this.hasAttribute("readonly")}
              target={{
                workspaceId: this.getAttribute("workspace-id") ?? "",
                databaseId: this.getAttribute("database-id") ?? "",
                rowId: this.getAttribute("row-id") ?? "",
              }}
            />
          ) : (
            <DatabaseEmbedMessage status="unavailable" />
          )
        ) : (
          <DatabaseEmbed
            databaseId={this.getAttribute("database-id") ?? ""}
            framework={this.frameworkValue}
            viewId={this.getAttribute("view-id")}
            workspaceFlavour={this.getAttribute("workspace-flavour")}
            workspaceId={this.getAttribute("workspace-id") ?? ""}
          />
        )}
      </MyoxusEmbeddedUIProvider>
    );
    this.root.render(
      this.frameworkValue ? (
        <FrameworkRoot framework={this.frameworkValue}>
          <SWRConfigProvider>{content}</SWRConfigProvider>
        </FrameworkRoot>
      ) : (
        content
      ),
    );
  }

  private observeThemeScope() {
    const themeScope = findEmbeddedThemeScope(this);
    if (themeScope === this.themeScope) return;

    this.themeObserver?.disconnect();
    this.themeScope = themeScope ?? undefined;
    if (!themeScope) return;

    this.themeObserver = new MutationObserver(() => this.renderReact());
    this.themeObserver.observe(themeScope, {
      attributeFilter: ["data-theme"],
      attributes: true,
    });
  }
}

function findEmbeddedThemeScope(element: Element): Element | null {
  let current: Element | null = element;
  while (current) {
    const themeScope = current.closest(
      "[data-theme='light'], [data-theme='dark']",
    );
    if (themeScope) return themeScope;

    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

/** Resolve the nearest editor theme across nested renderer shadow roots. */
export function resolveEmbeddedColorScheme(
  element: Element,
): "dark" | "light" | undefined {
  const theme = findEmbeddedThemeScope(element)?.getAttribute("data-theme");
  return theme === "dark" || theme === "light" ? theme : undefined;
}

export function defineDatabaseEmbedElement() {
  if (typeof customElements === "undefined") return;
  if (!customElements.get("myoxus-database-embed")) {
    customElements.define("myoxus-database-embed", DatabaseEmbedElement);
  }
}

export function renderServerDatabaseBlock(
  framework: FrameworkProvider,
  model: DatabaseReferenceBlockModel,
) {
  defineDatabaseEmbedElement();
  const workspaceId = framework.get(WorkspaceService).workspace.id;
  const workspaceFlavour = framework.get(WorkspaceService).workspace.flavour;
  const scope = resolveTaskReferenceScope(model.props, workspaceId);
  return html`<myoxus-database-embed
    .framework=${framework}
    ?readonly=${model.store.readonly}
    database-id=${model.props.serverDatabaseId ?? ""}
    reference-mode=${scope.kind}
    row-id=${scope.kind === "task" ? scope.rowId : ""}
    view-id=${model.props.serverViewId ?? ""}
    workspace-flavour=${workspaceFlavour}
    workspace-id=${workspaceId}
  ></myoxus-database-embed>`;
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-database-embed": DatabaseEmbedElement;
  }
}
