// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { WORKSPACE_DATABASE_PAGE_SIZE } from "@myoxus/core/modules/database";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { GlobalState } from "@myoxus/core/modules/storage";
import { TagService } from "@myoxus/core/modules/tag/service/tag";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { WorkspaceService } from "@myoxus/core/modules/workspace/services/workspace";
import {
  p9gRecord,
  record as fixtureRecord,
  rows as fixtureRows,
} from "@myoxus/core/modules/database/test-fixtures";
import {
  databaseEffectiveViewStateQuery,
  DatabaseFieldKind,
  DatabaseFormulaResultType,
  DatabaseFormulaStalePolicy,
  DatabaseFormulaStaleState,
  DatabaseRollupAggregate,
  DatabaseRollupStalePolicy,
  DatabaseRollupStaleState,
  DatabaseRowContentDocumentState,
  databaseRowsQuery,
  databaseRowTemplatesQuery,
  databaseSchemaQuery,
  DatabaseViewKind,
  databaseViewQuery,
  databaseViewsQuery,
  updateDatabaseCellValueMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import {
  type FrameworkProvider,
  FrameworkRoot,
  LiveData,
  MemoryMemento,
} from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DatabaseEmbed } from "./server-database-block";

const viewDelivery = vi.hoisted(() => ({
  load: vi.fn(),
  actual: undefined as (() => Promise<unknown>) | undefined,
}));
vi.mock("./load-view-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./load-view-host")>();
  viewDelivery.actual = actual.loadDatabaseViewHost;
  return { loadDatabaseViewHost: viewDelivery.load };
});

const TIMESTAMP = "2026-07-02T00:00:00Z";

const presenceHarness = vi.hoisted(() => ({
  onChange: null as ((event: unknown) => void) | null,
}));

vi.mock("../presence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../presence")>();
  return {
    ...actual,
    useDatabaseSocket: () => null,
    useDatabasePresence: (options: { onChange?: (event: unknown) => void }) => {
      presenceHarness.onChange = options.onChange ?? null;
      return {
        collaborators: [],
        connected: false,
        draggingUserIds: [],
        localSocketId: null,
        presenceByFieldId: new Map(),
        presenceByRowId: new Map(),
        refresh: async () => [],
        updateFocus: () => undefined,
      };
    },
  };
});

vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@myoxus/core/components/hooks/myoxus/use-user-preferences")
    >()),
    useRegionalPreferences: () => ({
      dateFormat: "locale" as const,
      locale: "en",
      timeFormat: "locale" as const,
      timezone: "UTC",
    }),
  }),
);

type EmbedGqlRequest = {
  query: unknown;
  signal?: AbortSignal;
  variables?: Record<string, unknown>;
};

function fixtureRow(title: string, id: string) {
  const source = fixtureRows[0]!;
  return {
    ...source,
    cells: source.cells.map((cell) => ({ ...cell, rowId: id })),
    cellRevisions: source.cellRevisions.map((cell) => ({ ...cell, rowId: id })),
    row: { ...source.row, id, title },
  };
}

function effectiveViewState(viewId: string) {
  return {
    workspace: {
      databaseEffectiveViewState: {
        canEditShared: true,
        canEditRows: true,
        effectiveFieldWidths: [],
        effectiveFilterTree: null,
        effectiveSort: [],
        personalState: null,
        savedFilterTree: null,
        savedSort: [],
        searchText: "",
        viewId,
      },
    },
  };
}

function renderFixtureEmbed(
  gql: (request: EmbedGqlRequest) => Promise<unknown>,
  options: { databaseId?: string; viewId?: string | null } = {},
) {
  const globalState = new MemoryMemento();
  const framework = {
    getOptional(this: { get(token: unknown): unknown }, token: unknown) {
      if (token === ViewService) return undefined;
      return this.get(token);
    },
    get(token: unknown) {
      if (token === GlobalState) return globalState;
      if (token === GraphQLService) return { gql };
      if (token === TagService) {
        return { tagColors: [], tagList: { tagMetas$: new LiveData([]) } };
      }
      if (token === WorkspaceServerService) return { server: null };
      if (token === WorkspaceService) {
        return { workspace: { flavour: "myoxus-cloud", id: "workspace-1" } };
      }
      if (token === WorkbenchService) {
        return { workbench: { open: vi.fn(), openDoc: vi.fn() } };
      }
      throw new Error(`Unexpected framework token: ${String(token)}`);
    },
  } as unknown as FrameworkProvider;
  const createSurface = (databaseId: string, viewId?: string | null) => (
    <FrameworkRoot framework={framework}>
      <SWRConfigProvider>
        <MyoxusUIProvider>
          <DatabaseEmbed
            databaseId={databaseId}
            framework={framework}
            viewId={viewId}
            workspaceId="workspace-1"
          />
        </MyoxusUIProvider>
      </SWRConfigProvider>
    </FrameworkRoot>
  );
  const rendered = render(
    createSurface(options.databaseId ?? "database-1", options.viewId),
  );
  return {
    ...rendered,
    rerenderEmbed(databaseId: string, viewId?: string | null) {
      rendered.rerender(createSurface(databaseId, viewId));
    },
  };
}

describe("server-backed database embed", () => {
  beforeEach(() =>
    viewDelivery.load.mockReset().mockImplementation(viewDelivery.actual!),
  );
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  test("renders server computed rollup and formula cells through the embedded interactive view", async () => {
    const gql = vi.fn(async ({ query }: { query: unknown }) => {
      if (query === databaseSchemaQuery) {
        return {
          workspace: {
            database: {
              database: {
                createdAt: TIMESTAMP,
                createdBy: "user-1",
                description: null,
                id: "database-1",
                title: "Embedded rollup database",
                updatedAt: TIMESTAMP,
                updatedBy: "user-1",
                workspaceId: "workspace-1",
              },
              fields: [
                {
                  config: {
                    date: null,
                    dateTime: null,
                    formula: null,
                    kind: DatabaseFieldKind.Title,
                    multiSelect: null,
                    number: null,
                    relation: null,
                    rollup: null,
                    select: null,
                    text: null,
                  },
                  createdAt: TIMESTAMP,
                  databaseId: "database-1",
                  fieldType: DatabaseFieldKind.Title,
                  id: "field-title",
                  name: "Title",
                  position: 0,
                  required: true,
                  updatedAt: TIMESTAMP,
                },
                {
                  config: {
                    date: null,
                    dateTime: null,
                    formula: null,
                    kind: DatabaseFieldKind.Rollup,
                    multiSelect: null,
                    number: null,
                    relation: null,
                    rollup: {
                      aggregate: DatabaseRollupAggregate.Sum,
                      emptyValue: null,
                      sourceRelationFieldId: "field-relation",
                      stalePolicy: DatabaseRollupStalePolicy.Async,
                      targetFieldId: "field-score",
                    },
                    select: null,
                    text: null,
                  },
                  createdAt: TIMESTAMP,
                  databaseId: "database-1",
                  fieldType: DatabaseFieldKind.Rollup,
                  id: "field-rollup",
                  name: "Task score",
                  position: 1,
                  required: false,
                  updatedAt: TIMESTAMP,
                },
                {
                  config: {
                    date: null,
                    dateTime: null,
                    formula: {
                      dependencyFieldIds: ["field-title"],
                      expression: 'concat("Item: ", [Title])',
                      format: null,
                      resultType: DatabaseFormulaResultType.Text,
                      stalePolicy: DatabaseFormulaStalePolicy.Async,
                    },
                    kind: DatabaseFieldKind.Formula,
                    multiSelect: null,
                    number: null,
                    relation: null,
                    rollup: null,
                    select: null,
                    text: null,
                  },
                  createdAt: TIMESTAMP,
                  databaseId: "database-1",
                  fieldType: DatabaseFieldKind.Formula,
                  id: "field-formula",
                  name: "Computed title",
                  position: 2,
                  required: false,
                  updatedAt: TIMESTAMP,
                },
              ],
              rowCount: 1,
              views: [
                {
                  config: {
                    calendar: null,
                    gallery: null,
                    kanban: null,
                    kind: DatabaseViewKind.Table,
                    list: null,
                    table: {
                      fieldWidths: [],
                      filter: [],
                      searchFieldIds: [],
                      sort: [],
                      titleFieldId: "field-title",
                      visibleFieldIds: [
                        "field-title",
                        "field-rollup",
                        "field-formula",
                      ],
                    },
                    timeline: null,
                  },
                  createdAt: TIMESTAMP,
                  databaseId: "database-1",
                  id: "view-table",
                  name: "Table",
                  position: 0,
                  updatedAt: TIMESTAMP,
                  viewKind: DatabaseViewKind.Table,
                },
              ],
            },
          },
        };
      }
      if (query === databaseViewsQuery) {
        return {
          workspace: {
            database: {
              views: [
                {
                  config: {
                    kind: DatabaseViewKind.Table,
                  },
                  createdAt: TIMESTAMP,
                  databaseId: "database-1",
                  id: "view-table",
                  name: "Table",
                  position: 0,
                  updatedAt: TIMESTAMP,
                  viewKind: DatabaseViewKind.Table,
                },
              ],
            },
          },
        };
      }
      if (query === databaseViewQuery) {
        return {
          workspace: {
            databaseView: {
              config: {
                calendar: null,
                gallery: null,
                kanban: null,
                kind: DatabaseViewKind.Table,
                list: null,
                table: {
                  fieldWidths: [],
                  filter: [],
                  filterTree: null,
                  group: null,
                  searchFieldIds: [],
                  sort: [],
                  subgroup: null,
                  titleFieldId: "field-title",
                  visibleFieldIds: [
                    "field-title",
                    "field-rollup",
                    "field-formula",
                  ],
                },
                timeline: null,
              },
              createdAt: TIMESTAMP,
              databaseId: "database-1",
              id: "view-table",
              name: "Table",
              position: 0,
              updatedAt: TIMESTAMP,
              viewKind: DatabaseViewKind.Table,
            },
          },
        };
      }
      if (query === databaseEffectiveViewStateQuery) {
        return {
          workspace: {
            databaseEffectiveViewState: {
              canEditShared: true,
              canEditRows: true,
              effectiveFieldWidths: [],
              effectiveFilterTree: null,
              effectiveSort: [],
              personalState: null,
              savedFilterTree: null,
              savedSort: [],
              searchText: "",
              viewId: "view-table",
            },
          },
        };
      }
      if (query === databaseRowsQuery) {
        return {
          workspace: {
            databaseRows: {
              rows: [
                {
                  cells: [
                    {
                      fieldId: "field-rollup",
                      fieldType: DatabaseFieldKind.Rollup,
                      rowId: "row-1",
                      updatedAt: TIMESTAMP,
                      updatedBy: "user-1",
                      value: {
                        checkbox: null,
                        date: null,
                        dateTime: null,
                        kind: DatabaseFieldKind.Rollup,
                        multiSelect: null,
                        number: null,
                        relation: null,
                        relationTargets: null,
                        rollup: {
                          computedAt: TIMESTAMP,
                          errorCode: null,
                          errorMessage: null,
                          failedAt: null,
                          staleState: DatabaseRollupStaleState.Current,
                          value: {
                            checkbox: null,
                            date: null,
                            kind: DatabaseFieldKind.Number,
                            number: 21,
                            text: null,
                          },
                        },
                        select: null,
                        text: null,
                        user: null,
                        url: null,
                        email: null,
                        phone: null,
                        createdTime: null,
                        createdBy: null,
                        updatedTime: null,
                        updatedBy: null,
                      },
                    },
                    {
                      fieldId: "field-formula",
                      fieldType: DatabaseFieldKind.Formula,
                      rowId: "row-1",
                      updatedAt: TIMESTAMP,
                      updatedBy: "user-1",
                      value: {
                        checkbox: null,
                        date: null,
                        dateTime: null,
                        formula: {
                          computedAt: TIMESTAMP,
                          errorCode: null,
                          errorMessage: null,
                          failedAt: null,
                          staleState: DatabaseFormulaStaleState.Current,
                          value: {
                            checkbox: null,
                            date: null,
                            kind: DatabaseFieldKind.Text,
                            number: null,
                            text: "Item: Embedded row",
                          },
                        },
                        kind: DatabaseFieldKind.Formula,
                        multiSelect: null,
                        number: null,
                        relation: null,
                        relationTargets: null,
                        rollup: null,
                        select: null,
                        text: null,
                        user: null,
                        url: null,
                        email: null,
                        phone: null,
                        createdTime: null,
                        createdBy: null,
                        updatedTime: null,
                        updatedBy: null,
                      },
                    },
                  ],
                  redacted: false,
                  row: {
                    createdAt: TIMESTAMP,
                    createdBy: "user-1",
                    databaseId: "database-1",
                    deletedAt: null,
                    contentDocument: {
                      documentId: "doc-1",
                      externalId: "doc-1",
                      state: DatabaseRowContentDocumentState.Available,
                      title: "Embedded row content",
                    },
                    id: "row-1",
                    position: 0,
                    title: "Embedded row",
                    updatedAt: TIMESTAMP,
                    updatedBy: "user-1",
                  },
                },
              ],
              totalCount: 1,
            },
          },
        };
      }
      if (query === databaseRowTemplatesQuery) {
        return {
          workspace: {
            databaseRowTemplates: [],
          },
        };
      }
      throw new Error("Unexpected database embed query");
    });
    const globalState = new MemoryMemento();
    const framework = {
      getOptional(this: { get(token: unknown): unknown }, token: unknown) {
        if (token === ViewService) return undefined;
        return this.get(token);
      },
      get(token: unknown) {
        if (token === GlobalState) return globalState;
        if (token === GraphQLService) return { gql };
        if (token === TagService) {
          return {
            tagColors: [],
            tagList: { tagMetas$: new LiveData([]) },
          };
        }
        if (token === WorkspaceServerService) return { server: null };
        if (token === WorkspaceService)
          return { workspace: { flavour: "myoxus-cloud", id: "workspace-1" } };
        if (token === WorkbenchService) {
          return { workbench: { open: vi.fn(), openDoc: vi.fn() } };
        }
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;
    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseEmbed
              databaseId="database-1"
              framework={framework}
              workspaceId="workspace-1"
            />
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='database-view-host-embed']"),
      ).not.toBeNull();
      expect(
        document.querySelector("[data-testid='database-table-view']"),
      ).not.toBeNull();
      expect(
        document.querySelector("[data-testid='database-field-plus']"),
      ).not.toBeNull();
      expect(
        document.querySelector("[data-testid='database-new-row']"),
      ).not.toBeNull();
      expect(
        document.querySelector("[data-testid='database-rollup-cell']"),
      ).not.toBeNull();
      expect(
        document.querySelector(
          "[data-testid='database-rollup-status'][data-rollup-state='Current']",
        ),
      ).not.toBeNull();
      expect(
        document.querySelector("[data-testid='database-formula-cell']"),
      ).not.toBeNull();
      expect(
        document.querySelector(
          "[data-testid='database-formula-status'][data-formula-state='Current']",
        ),
      ).not.toBeNull();
      expect(document.body.textContent).toContain("21");
      expect(document.body.textContent).toContain("Item: Embedded row");
    });
  });

  test("loads the complete server view when an embedded view tab changes", async () => {
    const titleField = {
      config: { kind: DatabaseFieldKind.Title },
      createdAt: TIMESTAMP,
      databaseId: "database-1",
      editRevision: 1,
      fieldType: DatabaseFieldKind.Title,
      id: "field-title",
      name: "Name",
      position: 0,
      required: true,
      updatedAt: TIMESTAMP,
    };
    const statusField = {
      config: {
        kind: DatabaseFieldKind.Select,
        select: {
          options: [
            {
              colorRole: "database.option.todo",
              id: "todo",
              name: "To do",
              position: 0,
            },
          ],
        },
      },
      createdAt: TIMESTAMP,
      databaseId: "database-1",
      editRevision: 1,
      fieldType: DatabaseFieldKind.Select,
      id: "field-status",
      name: "Status",
      position: 1,
      required: false,
      updatedAt: TIMESTAMP,
    };
    const tableSummary = {
      config: { kind: DatabaseViewKind.Table },
      createdAt: TIMESTAMP,
      databaseId: "database-1",
      editRevision: 1,
      id: "view-table",
      name: "Table",
      position: 0,
      updatedAt: TIMESTAMP,
      viewKind: DatabaseViewKind.Table,
    };
    const kanbanSummary = {
      config: { kind: DatabaseViewKind.Kanban },
      createdAt: TIMESTAMP,
      databaseId: "database-1",
      editRevision: 1,
      id: "view-kanban",
      name: "Board",
      position: 1,
      updatedAt: TIMESTAMP,
      viewKind: DatabaseViewKind.Kanban,
    };
    const gql = vi.fn(
      async ({
        query,
        variables,
      }: {
        query: unknown;
        variables?: Record<string, string>;
      }) => {
        if (query === databaseSchemaQuery) {
          return {
            workspace: {
              database: {
                database: {
                  createdAt: TIMESTAMP,
                  createdBy: "user-1",
                  description: null,
                  editRevision: 1,
                  id: "database-1",
                  profileConfig: {},
                  profileKind: "Generic",
                  profileStructurePreset: null,
                  title: "Embedded database",
                  updatedAt: TIMESTAMP,
                  updatedBy: "user-1",
                  workspaceId: "workspace-1",
                },
                fieldRoles: [],
                fields: [titleField, statusField],
                rowCount: 0,
                viewRoles: [],
              },
            },
          };
        }
        if (query === databaseViewsQuery) {
          return {
            workspace: { database: { views: [tableSummary, kanbanSummary] } },
          };
        }
        if (query === databaseViewQuery) {
          const kanban = variables?.viewId === "view-kanban";
          return {
            workspace: {
              databaseView: kanban
                ? {
                    ...kanbanSummary,
                    config: {
                      kanban: {
                        cardDensity: "Default",
                        coverFieldId: null,
                        filter: [],
                        filterTree: null,
                        groupFieldId: statusField.id,
                        sort: [],
                        titleFieldId: titleField.id,
                        visibleFieldIds: [titleField.id, statusField.id],
                      },
                      kind: DatabaseViewKind.Kanban,
                    },
                  }
                : {
                    ...tableSummary,
                    config: {
                      kind: DatabaseViewKind.Table,
                      table: {
                        fieldWidths: [],
                        filter: [],
                        filterTree: null,
                        group: null,
                        searchFieldIds: [titleField.id],
                        sort: [],
                        subgroup: null,
                        titleFieldId: titleField.id,
                        visibleFieldIds: [titleField.id, statusField.id],
                      },
                    },
                  },
            },
          };
        }
        if (query === databaseRowsQuery) {
          return { workspace: { databaseRows: { rows: [], totalCount: 0 } } };
        }
        if (query === databaseRowTemplatesQuery) {
          return { workspace: { databaseRowTemplates: [] } };
        }
        if (query === databaseEffectiveViewStateQuery) {
          return {
            workspace: {
              databaseEffectiveViewState: {
                canEditShared: true,
                canEditRows: true,
                effectiveFieldWidths: [],
                effectiveFilterTree: null,
                effectiveSort: [],
                personalState: null,
                savedFilterTree: null,
                savedSort: [],
                searchText: "",
                viewId: variables?.viewId ?? "view-table",
              },
            },
          };
        }
        throw new Error("Unexpected database embed query");
      },
    );
    const globalState = new MemoryMemento();
    const framework = {
      getOptional(this: { get(token: unknown): unknown }, token: unknown) {
        if (token === ViewService) return undefined;
        return this.get(token);
      },
      get(token: unknown) {
        if (token === GlobalState) return globalState;
        if (token === GraphQLService) return { gql };
        if (token === TagService) {
          return { tagColors: [], tagList: { tagMetas$: new LiveData([]) } };
        }
        if (token === WorkspaceServerService) return { server: null };
        if (token === WorkspaceService) {
          return { workspace: { flavour: "myoxus-cloud", id: "workspace-1" } };
        }
        if (token === WorkbenchService) {
          return { workbench: { open: vi.fn(), openDoc: vi.fn() } };
        }
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;

    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseEmbed
              databaseId="database-1"
              framework={framework}
              workspaceId="workspace-1"
            />
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Board" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='database-kanban-view-root']"),
      ).not.toBeNull();
      expect(document.body.textContent).toContain("To do");
    });
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: databaseViewQuery,
        variables: expect.objectContaining({ viewId: "view-kanban" }),
      }),
    );
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === databaseSchemaQuery,
      ),
    ).toHaveLength(1);
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === databaseViewsQuery,
      ),
    ).toHaveLength(1);
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === databaseRowTemplatesQuery,
      ),
    ).toHaveLength(1);
  });

  test("keeps the newest search and targets local and remote Row invalidation", async () => {
    const tableView = {
      ...fixtureRecord.views[0]!,
      config: {
        ...fixtureRecord.views[0]!.config,
        table: {
          ...fixtureRecord.views[0]!.config.table!,
          searchFieldIds: [fixtureRecord.fields[0]!.id],
        },
      },
    };
    const searchRecord = { ...fixtureRecord, views: [tableView] };
    let resolveFirstSearch:
      | ((value: {
          workspace: {
            databaseRows: {
              rows: ReturnType<typeof fixtureRow>[];
              totalCount: number;
            };
          };
        }) => void)
      | undefined;
    const firstSearch = new Promise<{
      workspace: {
        databaseRows: {
          rows: ReturnType<typeof fixtureRow>[];
          totalCount: number;
        };
      };
    }>((resolve) => {
      resolveFirstSearch = resolve;
    });
    const gql = vi.fn(async ({ query, variables }: EmbedGqlRequest) => {
      if (query === databaseSchemaQuery) {
        return { workspace: { database: searchRecord } };
      }
      if (query === databaseViewsQuery) {
        return { workspace: { database: { views: searchRecord.views } } };
      }
      if (query === databaseViewQuery) {
        return { workspace: { databaseView: tableView } };
      }
      if (query === databaseRowTemplatesQuery) {
        return { workspace: { databaseRowTemplates: [] } };
      }
      if (query === databaseEffectiveViewStateQuery) {
        return effectiveViewState(tableView.id);
      }
      if (query === upsertDatabaseViewUserStateMutation) {
        return { upsertDatabaseViewUserState: { editRevision: 2 } };
      }
      if (query === updateDatabaseCellValueMutation) {
        return {
          updateDatabaseCellValue: {
            editRevision: 2,
            value: { text: "Changed note" },
          },
        };
      }
      if (query === databaseRowsQuery) {
        const search = variables?.search;
        if (search === "first") return firstSearch;
        if (search === "second") {
          return {
            workspace: {
              databaseRows: {
                rows: [fixtureRow("Second result", "row-second")],
                totalCount: 1,
              },
            },
          };
        }
        return {
          workspace: {
            databaseRows: { rows: fixtureRows, totalCount: fixtureRows.length },
          },
        };
      }
      return {};
    });
    renderFixtureEmbed(gql);

    await screen.findByText("Initial task");
    const search = screen.getByTestId("database-table-search");
    fireEvent.change(search, { target: { value: "first" } });
    await waitFor(() =>
      expect(
        gql.mock.calls.some(
          ([request]) =>
            request.query === databaseRowsQuery &&
            request.variables?.search === "first",
        ),
      ).toBe(true),
    );
    fireEvent.change(search, { target: { value: "second" } });
    await screen.findByText("Second result");
    await act(async () => {
      resolveFirstSearch?.({
        workspace: {
          databaseRows: {
            rows: [fixtureRow("Obsolete result", "row-obsolete")],
            totalCount: 1,
          },
        },
      });
      await Promise.resolve();
    });
    expect(screen.queryByText("Obsolete result")).toBeNull();
    screen.getByText("Second result");

    const schemaReads = gql.mock.calls.filter(
      ([request]) => request.query === databaseSchemaQuery,
    ).length;
    const viewReads = gql.mock.calls.filter(
      ([request]) => request.query === databaseViewQuery,
    ).length;
    const templateReads = gql.mock.calls.filter(
      ([request]) => request.query === databaseRowTemplatesQuery,
    ).length;
    const rowReadsBeforeRemote = gql.mock.calls.filter(
      ([request]) => request.query === databaseRowsQuery,
    ).length;
    act(() => {
      presenceHarness.onChange?.({
        kind: "row_updated",
        target: { rowId: "row-second" },
      });
    });
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === databaseRowsQuery,
        ).length,
      ).toBeGreaterThan(rowReadsBeforeRemote),
    );
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === databaseSchemaQuery,
      ),
    ).toHaveLength(schemaReads);
    expect(
      gql.mock.calls.filter(([request]) => request.query === databaseViewQuery),
    ).toHaveLength(viewReads);
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === databaseRowTemplatesQuery,
      ),
    ).toHaveLength(templateReads);
  });

  test("retains a retryable host for transient Row errors and removes it on access loss", async () => {
    let rowFailure: unknown;
    const gql = vi.fn(async ({ query }: EmbedGqlRequest) => {
      if (query === databaseSchemaQuery) {
        return { workspace: { database: fixtureRecord } };
      }
      if (query === databaseViewsQuery) {
        return { workspace: { database: { views: fixtureRecord.views } } };
      }
      if (query === databaseViewQuery) {
        return { workspace: { databaseView: fixtureRecord.views[0] } };
      }
      if (query === databaseRowTemplatesQuery) {
        return { workspace: { databaseRowTemplates: [] } };
      }
      if (query === databaseEffectiveViewStateQuery) {
        return effectiveViewState(fixtureRecord.views[0]!.id);
      }
      if (query === databaseRowsQuery) {
        if (rowFailure) throw rowFailure;
        return {
          workspace: {
            databaseRows: { rows: fixtureRows, totalCount: fixtureRows.length },
          },
        };
      }
      return {};
    });
    renderFixtureEmbed(gql);
    await screen.findByText("Initial task");

    rowFailure = new Error("network unavailable");
    const rowReadsBeforeFailure = gql.mock.calls.filter(
      ([request]) => request.query === databaseRowsQuery,
    ).length;
    expect(presenceHarness.onChange).not.toBeNull();
    act(() => {
      presenceHarness.onChange?.({ kind: "row_updated" });
    });
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === databaseRowsQuery,
        ).length,
      ).toBeGreaterThan(rowReadsBeforeFailure),
    );
    await screen.findByRole("button", { name: "Retry" });
    expect(
      document.querySelector("[data-testid='database-rows-offline']") ??
        document.querySelector("[data-testid='database-rows-unavailable']"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid='database-view-host-embed']"),
    ).not.toBeNull();
    expect(screen.queryByText("Initial task")).toBeNull();

    rowFailure = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Initial task");

    rowFailure = { extensions: { code: "MIX_DATABASE_FORBIDDEN" } };
    act(() => {
      presenceHarness.onChange?.({ kind: "row_updated" });
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid='database-embed-forbidden']"),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector("[data-testid='database-view-host-embed']"),
    ).toBeNull();
  });

  test("completes a paged temporal window and discards the prior Database identity", async () => {
    const calendarView = p9gRecord.views.find(
      (view) => view.viewKind === DatabaseViewKind.Calendar,
    )!;
    let releaseSecondDatabase:
      | ((value: {
          workspace: {
            databaseRows: {
              rows: ReturnType<typeof fixtureRow>[];
              totalCount: number;
            };
          };
        }) => void)
      | undefined;
    const secondDatabaseRows = new Promise<{
      workspace: {
        databaseRows: {
          rows: ReturnType<typeof fixtureRow>[];
          totalCount: number;
        };
      };
    }>((resolve) => {
      releaseSecondDatabase = resolve;
    });
    const gql = vi.fn(async ({ query, variables }: EmbedGqlRequest) => {
      const databaseId = String(variables?.databaseId ?? "database-1");
      const source = {
        ...p9gRecord,
        database: {
          ...p9gRecord.database,
          id: databaseId,
          title: databaseId === "database-2" ? "Second database" : "Roadmap",
        },
      };
      if (query === databaseSchemaQuery) {
        return { workspace: { database: source } };
      }
      if (query === databaseViewsQuery) {
        return { workspace: { database: { views: source.views } } };
      }
      if (query === databaseViewQuery) {
        return { workspace: { databaseView: calendarView } };
      }
      if (query === databaseRowTemplatesQuery) {
        return { workspace: { databaseRowTemplates: [] } };
      }
      if (query === databaseEffectiveViewStateQuery) {
        return effectiveViewState(calendarView.id);
      }
      if (query === databaseRowsQuery) {
        if (databaseId === "database-2") return secondDatabaseRows;
        const after = variables?.after;
        const page = Array.from(
          { length: after ? 1 : WORKSPACE_DATABASE_PAGE_SIZE },
          (_, index) =>
            fixtureRow(
              `Temporal ${after ? WORKSPACE_DATABASE_PAGE_SIZE : 0 + index}`,
              `temporal-${after ? WORKSPACE_DATABASE_PAGE_SIZE : index}`,
            ),
        );
        return {
          workspace: {
            databaseRows: {
              endCursor: after ? "cursor-51" : "cursor-50",
              rows: page,
              totalCount: WORKSPACE_DATABASE_PAGE_SIZE + 1,
            },
          },
        };
      }
      return {};
    });
    const rendered = renderFixtureEmbed(gql, { viewId: calendarView.id });
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === databaseRowsQuery,
        ),
      ).toHaveLength(2),
    );

    await act(async () => {
      rendered.rerenderEmbed("database-2", calendarView.id);
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-testid='database-rows-loading']"),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("Roadmap")).toBeNull();
    await act(async () => {
      releaseSecondDatabase?.({
        workspace: {
          databaseRows: {
            rows: [fixtureRow("Second identity Row", "row-second-identity")],
            totalCount: 1,
          },
        },
      });
      await Promise.resolve();
    });
    await screen.findByText("Second database");
    expect(screen.queryByText("Roadmap")).toBeNull();
  });

  test.each([
    ["forbidden", { extensions: { code: "MIX_DATABASE_FORBIDDEN" } }],
    ["missing", { extensions: { code: "MIX_DATABASE_NOT_FOUND" } }],
    ["unavailable", new Error("network unavailable")],
  ] as const)(
    "renders the shared %s failure state when the server-backed query fails",
    async (status, error) => {
      const gql = vi.fn(async () => {
        throw error;
      });
      const globalState = new MemoryMemento();
      const framework = {
        getOptional(this: { get(token: unknown): unknown }, token: unknown) {
          if (token === ViewService) return undefined;
          return this.get(token);
        },
        get(token: unknown) {
          if (token === GlobalState) return globalState;
          if (token === GraphQLService) return { gql };
          if (token === WorkspaceService) {
            return {
              workspace: {
                flavour: "myoxus-cloud",
                id: "workspace-1",
              },
            };
          }
          if (token === WorkbenchService) {
            return { workbench: { open: vi.fn(), openDoc: vi.fn() } };
          }
          throw new Error(`Unexpected framework token: ${String(token)}`);
        },
      } as unknown as FrameworkProvider;

      render(
        <FrameworkRoot framework={framework}>
          <SWRConfigProvider>
            <MyoxusUIProvider>
              <DatabaseEmbed
                databaseId="database-1"
                framework={framework}
                workspaceId="workspace-1"
              />
            </MyoxusUIProvider>
          </SWRConfigProvider>
        </FrameworkRoot>,
      );

      await waitFor(() => {
        expect(
          document.querySelector(`[data-testid='database-embed-${status}']`),
        ).not.toBeNull();
      });
      expect(gql).toHaveBeenCalled();
    },
  );

  test("keeps ready server data while deferred delivery fails and retries only the view", async () => {
    const pending = Promise.withResolvers<unknown>();
    viewDelivery.load.mockReturnValueOnce(pending.promise);
    const gql = vi.fn(async ({ query }: EmbedGqlRequest) => {
      if (query === databaseSchemaQuery)
        return { workspace: { database: fixtureRecord } };
      if (query === databaseViewsQuery)
        return { workspace: { database: { views: fixtureRecord.views } } };
      if (query === databaseViewQuery)
        return { workspace: { databaseView: fixtureRecord.views[0] } };
      if (query === databaseRowTemplatesQuery)
        return { workspace: { databaseRowTemplates: [] } };
      if (query === databaseEffectiveViewStateQuery)
        return effectiveViewState(fixtureRecord.views[0]!.id);
      if (query === databaseRowsQuery)
        return {
          workspace: {
            databaseRows: { rows: fixtureRows, totalCount: fixtureRows.length },
          },
        };
      return {};
    });
    renderFixtureEmbed(gql);
    await waitFor(() => expect(viewDelivery.load).toHaveBeenCalledOnce());
    expect(screen.getByTestId("database-embed-loading")).not.toBeNull();
    expect(screen.queryByText("Initial task")).toBeNull();
    await act(async () =>
      pending.reject(new Error("Deferred asset unavailable")),
    );
    await screen.findByTestId("database-embed-unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Initial task");
    expect(viewDelivery.load).toHaveBeenCalledTimes(2);
    expect(
      gql.mock.calls.filter(
        ([request]) => request.query === databaseSchemaQuery,
      ),
    ).toHaveLength(1);
    expect(screen.queryByTestId("database-embed-unavailable")).toBeNull();
  });

  test("renders a local-workspace unavailable state without issuing GraphQL queries", async () => {
    const gql = vi.fn();
    const globalState = new MemoryMemento();
    const framework = {
      getOptional(this: { get(token: unknown): unknown }, token: unknown) {
        if (token === ViewService) return undefined;
        return this.get(token);
      },
      get(token: unknown) {
        if (token === GlobalState) return globalState;
        if (token === GraphQLService) return { gql };
        if (token === WorkspaceService) {
          return { workspace: { flavour: "local", id: "local-1" } };
        }
        if (token === WorkbenchService) {
          return { workbench: { open: vi.fn(), openDoc: vi.fn() } };
        }
        throw new Error(`Unexpected framework token: ${String(token)}`);
      },
    } as unknown as FrameworkProvider;

    render(
      <FrameworkRoot framework={framework}>
        <SWRConfigProvider>
          <MyoxusUIProvider>
            <DatabaseEmbed
              databaseId="database-1"
              framework={framework}
              workspaceFlavour="local"
              workspaceId="local-1"
            />
          </MyoxusUIProvider>
        </SWRConfigProvider>
      </FrameworkRoot>,
    );

    await waitFor(() => {
      expect(
        document.querySelector(
          "[data-testid='database-embed-local-unavailable']",
        ),
      ).not.toBeNull();
      expect(document.body.textContent).toContain(
        "com.myoxus.database.server-backed-only.title",
      );
    });
    expect(gql).not.toHaveBeenCalled();
    expect(viewDelivery.load).not.toHaveBeenCalled();
  });
});
