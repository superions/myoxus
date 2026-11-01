// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import "./test-editor-boundary";

import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { GuardService } from "@myoxus/core/modules/permissions";
import { GlobalState } from "@myoxus/core/modules/storage";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { DefaultServerService } from "@myoxus/core/modules/server/services/default-server";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { PublicUserService } from "@myoxus/core/modules/server";
import { ServersService } from "@myoxus/core/modules/server/services/servers";
import { UserPreferencesService } from "@myoxus/core/modules/server/services/user-preferences";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { TagService } from "@myoxus/core/modules/tag/service/tag";
import { BuiltinTemplateReconcilerService } from "@myoxus/core/modules/template-doc/services/builtin-reconciler";
import { TemplateDocService } from "@myoxus/core/modules/template-doc/services/template-doc";
import {
  createDatabaseViewMutation,
  databaseRowTemplateBodyInputsQuery,
  documentReviewForTaskQuery,
  databaseEffectiveViewStateQuery,
  DatabaseFilterConjunction,
  ServerDeploymentType,
  deleteDatabaseViewMutation,
  reorderDatabaseViewsMutation,
  resetDatabaseViewUserStateMutation,
  saveDatabaseViewUserStateMutation,
  updateDatabaseViewMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import {
  type FrameworkProvider,
  FrameworkRoot,
  Framework,
  LiveData,
  MemoryMemento,
  useLiveData,
} from "@myoxus/infra";
import { ConfirmModalProvider, notify } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, vi } from "vitest";
import { SWRConfig } from "swr";

import { WorkspaceDialogService } from "../dialogs";
import { TemplateInputPromptService } from "../template-doc/services/template-input-prompt";
import { TemplateInputDialog } from "../template-doc/view/template-input-dialog";
import { ViewService } from "../workbench/services/view";
import { WorkbenchService } from "../workbench/services/workbench";
import { ContextSurfaceHost } from "../workbench/view/context-panel/context-surface-host";
import { ViewIslandRegistryProvider } from "../workbench/view/view-islands";
import type { DatabaseRowDetailLoadState } from "./row-detail";
import { record, rows } from "./test-fixtures";
import {
  type DatabaseRecord,
  type DatabaseRowRecord,
  type DatabaseRowTemplateBinding,
  type DatabaseView,
} from "./types";
import { DatabaseViewHost, type DatabaseViewHostProps } from "./view-host";

const presenceOverride = vi.hoisted(() => ({
  current: null as unknown,
  onChange: null as ((event: unknown) => void) | null,
}));

const effectiveStateOverride = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("@myoxus/core/components/hooks/use-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@myoxus/core/components/hooks/use-query")
    >();
  return {
    ...actual,
    useQuery: (options: { query?: { id?: string } }, config?: unknown) => {
      if (options?.query?.id === "databaseEffectiveViewStateQuery") {
        return {
          data: effectiveStateOverride.current,
          error: undefined,
          isLoading: false,
          mutate: async () => effectiveStateOverride.current,
        };
      }
      return actual.useQuery(options as never, config as never);
    },
  };
});

vi.mock("./presence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./presence")>();
  const emptyPresence = {
    collaborators: [],
    connected: false,
    localSocketId: null,
    presenceByRowId: new Map(),
    presenceByFieldId: new Map(),
    draggingUserIds: [],
    updateFocus: () => undefined,
    refresh: async () => [],
  };
  return {
    ...actual,
    useDatabaseSocket: () => null,
    useDatabasePresence: (options: { onChange?: (event: unknown) => void }) => {
      presenceOverride.onChange = options.onChange ?? null;
      return presenceOverride.current ?? emptyPresence;
    },
  };
});

export function setDatabasePresenceOverride(current: unknown) {
  presenceOverride.current = current;
}

export function emitDatabasePresenceChange(event: unknown) {
  presenceOverride.onChange?.(event);
}

export function renderDatabaseViewHost(
  options: {
    activeViewId?: string;
    contextPanelOpen?: boolean;
    effectiveState?: Record<string, unknown>;
    record?: DatabaseRecord;
    gql?: (request: { mutation?: unknown; query?: unknown }) => unknown;
    initialRowId?: string | null;
    initialRowLoadState?: DatabaseRowDetailLoadState | null;
    layout?: "embedded" | "page";
    onActiveViewChange?: DatabaseViewHostProps["onActiveViewChange"];
    onCopyRowLink?: DatabaseViewHostProps["onCopyRowLink"];
    onCopyViewLink?: DatabaseViewHostProps["onCopyViewLink"];
    onExportCsvRows?: DatabaseViewHostProps["onExportCsvRows"];
    onRemoteChange?: DatabaseViewHostProps["onRemoteChange"];
    onRowDetailChange?: DatabaseViewHostProps["onRowDetailChange"];
    onSearchChange?: DatabaseViewHostProps["onSearchChange"];
    renderPageHeader?: DatabaseViewHostProps["renderPageHeader"];
    rowTemplates?: DatabaseRowTemplateBinding[];
    rowTemplateInputs?: {
      requiredInputs: string[];
      sourceRevision: string | null;
    };
    rows?: DatabaseRowRecord[];
    rowGroups?: DatabaseViewHostProps["rowGroups"];
    scheduleDate?: string;
    search?: string;
    tagService?: unknown;
    publicUserService?: unknown;
  } = {},
) {
  const selectedRecord = options.record ?? record;
  const selectedView =
    selectedRecord.views.find(
      (view) => view.id === (options.activeViewId ?? "view-table"),
    ) ?? selectedRecord.views[0]!;
  const effectiveStateForView = (view: DatabaseView) => {
    const config =
      view.config.table ??
      view.config.kanban ??
      view.config.list ??
      view.config.gallery ??
      view.config.calendar ??
      view.config.gantt ??
      view.config.timeline ??
      view.config.progress!;
    const savedFilterTree =
      config.filterTree ??
      (config.filter.length
        ? {
            conjunction: DatabaseFilterConjunction.And,
            groups: [],
            rules: config.filter,
          }
        : null);
    return {
      workspace: {
        databaseEffectiveViewState: {
          canEditShared: true,
          canEditRows: true,
          effectiveFieldWidths: view.config.table?.fieldWidths ?? [],
          effectiveFilterTree: savedFilterTree,
          effectiveSort: config.sort,
          personalState: null,
          savedFilterTree,
          savedSort: config.sort,
          searchText: options.search ?? "",
          viewId: view.id,
          ...options.effectiveState,
        },
      },
    };
  };
  const effectiveStateResponse = effectiveStateForView(selectedView);
  effectiveStateOverride.current = effectiveStateResponse;
  const customGql = options.gql;
  const account$ = new LiveData({ id: "database-test-actor" });
  const personalStateAcknowledgements: number[] = [];
  const gql = vi.fn(
    (request: {
      mutation?: unknown;
      query?: unknown;
      variables?: { input?: { expectedEditRevision?: number } };
    }) => {
      const operation = request.query ?? request.mutation;
      if (operation === documentReviewForTaskQuery)
        return {
          currentUser: { id: account$.value.id },
          workspace: {
            id: selectedRecord.database.workspaceId,
            documentReviewForTask: null,
          },
        };
      if (operation === databaseRowTemplateBodyInputsQuery) {
        return {
          workspace: {
            databaseRowTemplateBodyInputs: options.rowTemplateInputs ?? {
              requiredInputs: [],
              sourceRevision: null,
            },
          },
        };
      }
      if (operation === databaseEffectiveViewStateQuery) {
        return effectiveStateOverride.current;
      }
      if (operation === upsertDatabaseViewUserStateMutation) {
        // Native revisions are opaque sequence tokens, not a per-state counter.
        const editRevision = 41 + personalStateAcknowledgements.length * 17;
        personalStateAcknowledgements.push(editRevision);
        return { upsertDatabaseViewUserState: { editRevision } };
      }
      if (operation === resetDatabaseViewUserStateMutation) {
        return { resetDatabaseViewUserState: true };
      }
      if (operation === saveDatabaseViewUserStateMutation) {
        return { saveDatabaseViewUserState: selectedView };
      }
      if (customGql) return customGql(request);
      if (operation === createDatabaseViewMutation) {
        return { createDatabaseView: selectedView };
      }
      if (operation === deleteDatabaseViewMutation) {
        return { deleteDatabaseView: true };
      }
      if (operation === reorderDatabaseViewsMutation) {
        return { reorderDatabaseViews: selectedRecord.views };
      }
      if (operation === updateDatabaseViewMutation) {
        return { updateDatabaseView: selectedView };
      }
      return {};
    },
  );
  const tagService =
    options.tagService ??
    ({
      tagColors: [],
      tagList: {
        catalogState$: new LiveData({
          status: "ready" as const,
          tags: [],
          error: null,
        }),
        tagMetas$: new LiveData([]),
        archiveTag: vi.fn(),
        createTag: vi.fn(),
        deleteTag: vi.fn(),
        restoreTag: vi.fn(),
        retryCatalog: vi.fn(),
        tagByTagId$: vi.fn(() => new LiveData(undefined)),
      },
    } as const);
  const userPreferencesService = {
    userPreferences$: new LiveData(undefined),
    workbenchToolLayouts$: new LiveData({
      confirmed: null,
      projected: null,
      syncStatus: "confirmed" as const,
    }),
    update: vi.fn(async () => {}),
    updateWorkbenchToolLayout: vi.fn(async () => {}),
  };
  const server = {
    id: "database-test-server",
    baseUrl: "https://example.test",
    account$,
    gql,
    config$: new LiveData({ type: ServerDeploymentType.Standalone }),
    scope: {
      get(token: unknown) {
        if (token === UserPreferencesService) return userPreferencesService;
        throw new Error(`Unexpected server-scoped token: ${String(token)}`);
      },
    },
  };
  // Real framework services retain their identity across consumer renders.
  const workspaceServerService = { server, server$: new LiveData(server) };
  const workspaceService = {
    workspace: {
      id: selectedRecord.database.workspaceId,
      flavour: "myoxus-cloud",
    },
  };
  const globalContextService = {
    globalContext: {
      serverId: { $: new LiveData<string | undefined>(undefined) },
    },
  };
  type TestContextSurface = {
    id: string;
    label?: string;
    order?: number;
    tooltip?: string;
    viewFamilies?: readonly string[];
  };
  const contextSurfaces$ = new LiveData<TestContextSurface[]>([]);
  const toolLayout$ = new LiveData({
    orderedToolIds: [] as string[],
    visibleToolIds: [] as string[],
    collapsedToolIds: [] as string[],
  });
  const workbenchView = {
    id: "database-test-view",
    contextSurfaces$,
    toolViewFamily$: new LiveData("database"),
    toolLayout$,
    toolHeaderFocusRequest$: new LiveData(null),
    addContextSurface(surface: TestContextSurface) {
      const next = [
        ...contextSurfaces$.value.filter((entry) => entry.id !== surface.id),
        surface,
      ];
      contextSurfaces$.next(next);
      if (!toolLayout$.value.orderedToolIds.includes(surface.id)) {
        toolLayout$.next({
          ...toolLayout$.value,
          orderedToolIds: [...toolLayout$.value.orderedToolIds, surface.id],
          visibleToolIds:
            surface.id === "database-settings"
              ? [...toolLayout$.value.visibleToolIds, surface.id]
              : toolLayout$.value.visibleToolIds,
        });
      }
    },
    removeContextSurface(surfaceId: string) {
      contextSurfaces$.next(
        contextSurfaces$.value.filter((entry) => entry.id !== surfaceId),
      );
    },
    bindToolLayout() {
      return () => {};
    },
    showTool(surfaceId: string) {
      toolLayout$.next({
        ...toolLayout$.value,
        visibleToolIds: Array.from(
          new Set([...toolLayout$.value.visibleToolIds, surfaceId]),
        ),
      });
      contextPanelOpen$.next(true);
    },
    hideTool(surfaceId: string) {
      const visibleToolIds = toolLayout$.value.visibleToolIds.filter(
        (id) => id !== surfaceId,
      );
      toolLayout$.next({
        ...toolLayout$.value,
        visibleToolIds,
      });
      if (visibleToolIds.length === 0) contextPanelOpen$.next(false);
    },
    toggleToolCollapsed: vi.fn(),
    moveTool: vi.fn(),
  };
  const contextPanelOpen$ = new LiveData(options.contextPanelOpen ?? false);
  const workbench = {
    contextPanelOpen$,
    setContextPanelOpen(open: boolean) {
      contextPanelOpen$.next(open);
    },
    openContextPanel() {
      contextPanelOpen$.next(true);
    },
    closeContextPanel() {
      contextPanelOpen$.next(false);
    },
  };
  const inputFramework = new Framework();
  inputFramework.service(WorkspaceDialogService);
  inputFramework.service(TemplateInputPromptService, [WorkspaceDialogService]);
  const inputProvider = inputFramework.provider();
  const graphqlService = { gql };
  const attempts = new MemoryMemento();
  const globalState = Object.assign(attempts, {
    getConfirmed: async <T,>(key: string) => attempts.get<T>(key),
    setConfirmed: async <T,>(key: string, value: T | undefined) => {
      attempts.set(key, value);
    },
  });
  const framework = {
    get(token: unknown) {
      if (token === GlobalState) return globalState;
      if (token === GraphQLService) return graphqlService;
      if (token === TemplateInputPromptService)
        return inputProvider.get(TemplateInputPromptService);
      if (token === PublicUserService) return options.publicUserService;
      if (token === TagService) return tagService;
      if (token === WorkspaceServerService) return workspaceServerService;
      if (token === WorkspaceService) return workspaceService;
      if (token === GuardService) return { can$: () => new LiveData(true) };
      if (token === DefaultServerService)
        return { server, server$: new LiveData(server) };
      if (token === GlobalContextService) return globalContextService;
      if (token === ServersService) return { server$: vi.fn() };
      if (token === BuiltinTemplateReconcilerService) {
        return { reconcile: vi.fn(async () => {}) };
      }
      if (token === TemplateDocService) {
        return { loadTemplateSuggestions: vi.fn(async () => {}) };
      }
      if (token === ViewService) return { view: workbenchView };
      if (token === WorkbenchService) return { workbench };
      throw new Error(`Unexpected framework token: ${String(token)}`);
    },
    getOptional() {
      return undefined;
    },
  } as unknown as FrameworkProvider;
  const onChanged = vi.fn(async () => {});
  const onOpenDoc = vi.fn();
  const onActiveViewChange = options.onActiveViewChange ?? vi.fn();
  const onCopyRowLink = options.onCopyRowLink;
  const onCopyViewLink = options.onCopyViewLink ?? vi.fn(async () => true);

  // Keep each fixture independent while retaining its cache across rerenders.
  const queryCache = new Map();
  const createSurface = (
    nextRecord: DatabaseRecord,
    nextRows: DatabaseRowRecord[],
    nextActiveViewId = options.activeViewId ?? selectedView.id,
  ) => (
    <SWRConfig value={{ provider: () => queryCache, dedupingInterval: 0 }}>
      <FrameworkRoot framework={framework}>
        <ViewIslandRegistryProvider>
          <SWRConfigProvider>
            <MyoxusUIProvider env="test">
              <ConfirmModalProvider>
                <TemplateDialogs
                  dialogs={inputProvider.get(WorkspaceDialogService)}
                />
                <DatabaseViewHost
                  activeViewId={nextActiveViewId}
                  databaseId="database-1"
                  initialRowId={options.initialRowId}
                  initialRowLoadState={options.initialRowLoadState}
                  layout={options.layout ?? "embedded"}
                  onActiveViewChange={onActiveViewChange}
                  onChanged={onChanged}
                  onCopyRowLink={onCopyRowLink}
                  onCopyViewLink={onCopyViewLink}
                  onExportCsvRows={options.onExportCsvRows}
                  onOpenDoc={onOpenDoc}
                  onRemoteChange={options.onRemoteChange}
                  onRowDetailChange={options.onRowDetailChange}
                  onSearchChange={options.onSearchChange}
                  renderPageHeader={options.renderPageHeader}
                  record={nextRecord}
                  rowTemplates={options.rowTemplates}
                  rows={nextRows}
                  rowGroups={options.rowGroups}
                  scheduleDate={options.scheduleDate}
                  search={options.search}
                  workspaceId="workspace-1"
                />
                <ContextSurfaceHost />
              </ConfirmModalProvider>
            </MyoxusUIProvider>
          </SWRConfigProvider>
        </ViewIslandRegistryProvider>
      </FrameworkRoot>
    </SWRConfig>
  );
  const surface = createSurface(options.record ?? record, options.rows ?? rows);
  const rendered = render(surface);

  return {
    gql,
    personalStateAcknowledgements,
    server,
    onActiveViewChange,
    onChanged,
    onCopyRowLink,
    onCopyViewLink,
    onOpenDoc,
    workbench,
    workbenchView,
    rerender: (
      nextRecord: DatabaseRecord,
      nextRows: DatabaseRowRecord[],
      nextActiveViewId = options.activeViewId ?? selectedView.id,
    ) => {
      const nextView =
        nextRecord.views.find((view) => view.id === nextActiveViewId) ??
        nextRecord.views[0]!;
      effectiveStateOverride.current = effectiveStateForView(nextView);
      rendered.rerender(createSurface(nextRecord, nextRows, nextActiveViewId));
    },
  };
}

export async function selectFacadeOption(
  container: HTMLElement,
  label: string,
  option: string,
) {
  const user = userEvent.setup();
  const select = within(container).getByRole("combobox", { name: label });
  await user.click(select);
  const selectedOption = await screen.findByRole("option", { name: option });
  await user.click(selectedOption);
  await waitFor(() => expect((select as HTMLInputElement).value).toBe(option));
}

afterEach(() => {
  notify.dismiss();
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  effectiveStateOverride.current = null;
  presenceOverride.current = null;
  presenceOverride.onChange = null;
});

function TemplateDialogs({ dialogs }: { dialogs: WorkspaceDialogService }) {
  const open = useLiveData(dialogs.dialogs$);
  return open.map((dialog) =>
    dialog.type === "template-inputs" ? (
      <TemplateInputDialog
        key={dialog.id}
        {...dialog.props}
        close={() => dialogs.close(dialog.id)}
      />
    ) : null,
  );
}
