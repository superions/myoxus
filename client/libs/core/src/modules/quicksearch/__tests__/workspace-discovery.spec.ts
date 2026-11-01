/**
 * @vitest-environment happy-dom
 */

import {
  databaseSearchQuery,
  databasesQuery,
  type GraphQLQuery,
} from "@myoxus/graphql";
import { Framework, LiveData } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { CollectionService } from "../../collection";
import { DocsService } from "../../doc";
import { DocDisplayMetaService } from "../../doc-display-meta";
import { FavoriteService } from "../../favorite";
import { WorkspaceServerService } from "../../server";
import { TagService } from "../../tag";
import { WorkspaceService } from "../../workspace";
import { DatabaseRowsQuickSearchSession } from "../impls/database-rows";
import { DatabasesQuickSearchSession } from "../impls/databases";
import { FavoritesQuickSearchSession } from "../impls/favorites";
import { RecentTargetsQuickSearchSession } from "../impls/recent-targets";
import { RecentWorkspaceItemsService } from "../services/recent-workspace-items";

function databaseSummary(id: string, title: string) {
  return {
    createdAt: "2026-07-20T00:00:00Z",
    deletedAt: null,
    description: null,
    editRevision: 1,
    fieldCount: 0,
    id,
    profileKind: "GENERIC",
    systemRole: null,
    rowCount: 0,
    title,
    updatedAt: "2026-07-27T00:00:00Z",
    viewCount: 0,
  };
}

function docRecord(id: string, trash = false) {
  return {
    id,
    meta$: new LiveData({ trash, updatedDate: 42 }),
    primaryMode$: new LiveData("page"),
    trash$: new LiveData(trash),
  };
}

function createDatabasesSession(gql: ReturnType<typeof vi.fn>) {
  const framework = new Framework();
  framework
    .service(WorkspaceService, {
      workspace: { id: "workspace" },
    } as any)
    .service(WorkspaceServerService, { server: { gql } } as any)
    .entity(DatabasesQuickSearchSession, [
      WorkspaceService,
      WorkspaceServerService,
    ]);
  return framework.provider().createEntity(DatabasesQuickSearchSession);
}

function createDatabaseRowsSession(gql: ReturnType<typeof vi.fn>) {
  const framework = new Framework();
  framework
    .service(WorkspaceService, {
      workspace: { id: "workspace" },
    } as any)
    .service(WorkspaceServerService, { server: { gql } } as any)
    .entity(DatabaseRowsQuickSearchSession, [
      WorkspaceService,
      WorkspaceServerService,
    ]);
  return framework.provider().createEntity(DatabaseRowsQuickSearchSession);
}

describe("workspace Database discovery", () => {
  test("does not query for empty input and maps server-ordered Database routes", async () => {
    const gql = vi.fn(async () => ({
      workspace: {
        databases: [
          databaseSummary("database-b", "Beta"),
          databaseSummary("database-a", "Alpha"),
        ],
      },
    }));
    const session = createDatabasesSession(gql);

    session.query(" ");
    expect(gql).not.toHaveBeenCalled();

    session.query("project");
    await vi.waitFor(() => expect(session.isLoading$.value).toBe(false));

    expect(gql).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        query: databasesQuery,
        variables: expect.objectContaining({
          first: 6,
          search: "project",
          workspaceId: "workspace",
        }),
      }),
    );
    expect(session.items$.value.map((item) => item.payload)).toEqual([
      {
        databaseId: "database-b",
        route: "/databases/database-b",
      },
      {
        databaseId: "database-a",
        route: "/databases/database-a",
      },
    ]);
  });

  test("ignores a stale response even when the transport does not honor abort", async () => {
    const resolvers = new Map<string, (value: unknown) => void>();
    const gql = vi.fn(
      ({ variables }: { variables: { search?: string } }) =>
        new Promise((resolve) => {
          resolvers.set(variables.search ?? "", resolve);
        }),
    );
    const session = createDatabasesSession(gql);

    session.query("old");
    session.query("new");
    resolvers.get("new")?.({
      workspace: { databases: [databaseSummary("new", "New")] },
    });
    await vi.waitFor(() =>
      expect(session.items$.value[0]?.payload.databaseId).toBe("new"),
    );
    resolvers.get("old")?.({
      workspace: { databases: [databaseSummary("old", "Old")] },
    });
    await Promise.resolve();

    expect(session.items$.value[0]?.payload.databaseId).toBe("new");
  });

  test("searches rows once and resolves unique Database context in one batch", async () => {
    const gql = vi.fn(async ({ query }: { query: GraphQLQuery }) =>
      query === databaseSearchQuery
        ? {
            workspace: {
              databaseSearch: [
                {
                  databaseId: "database-a",
                  hasContentDocument: true,
                  rowId: "row-a",
                  snippet: "Alpha body",
                  title: "Alpha row",
                  updatedAt: "2026-07-27T00:00:00Z",
                },
                {
                  databaseId: "database-a",
                  hasContentDocument: false,
                  rowId: "row-b",
                  snippet: null,
                  title: "Beta row",
                  updatedAt: "2026-07-26T00:00:00Z",
                },
              ],
            },
          }
        : {
            workspace: {
              databases: [databaseSummary("database-a", "Projects")],
            },
          },
    );
    const session = createDatabaseRowsSession(gql);

    session.query("alpha");
    await vi.waitFor(() => expect(session.isLoading$.value).toBe(false));

    expect(gql).toHaveBeenCalledTimes(2);
    expect(gql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: databasesQuery,
        variables: expect.objectContaining({
          databaseIds: ["database-a"],
          first: 1,
        }),
      }),
    );
    expect(session.items$.value).toEqual([
      expect.objectContaining({
        label: { subTitle: "Projects", title: "Alpha row" },
        payload: {
          databaseId: "database-a",
          route: "/databases/database-a?rowId=row-a",
          rowId: "row-a",
        },
      }),
      expect.objectContaining({
        label: { subTitle: "Projects", title: "Beta row" },
        payload: {
          databaseId: "database-a",
          route: "/databases/database-a?rowId=row-b",
          rowId: "row-b",
        },
      }),
    ]);
  });

  test("keeps authorized row routes usable when only context enrichment fails", async () => {
    const gql = vi.fn(async ({ query }: { query: GraphQLQuery }) => {
      if (query === databaseSearchQuery) {
        return {
          workspace: {
            databaseSearch: [
              {
                databaseId: "database",
                hasContentDocument: false,
                rowId: "row",
                snippet: null,
                title: "Safe row",
                updatedAt: "2026-07-27T00:00:00Z",
              },
            ],
          },
        };
      }
      throw new Error("context unavailable");
    });
    const session = createDatabaseRowsSession(gql);

    session.query("safe");
    await vi.waitFor(() => expect(session.isLoading$.value).toBe(false));

    expect(session.error$.value).toEqual(expect.any(Error));
    expect(session.items$.value[0]).toEqual(
      expect.objectContaining({
        label: { subTitle: undefined, title: "Safe row" },
        payload: expect.objectContaining({
          route: "/databases/database?rowId=row",
        }),
      }),
    );
  });

  test("does not request Database context when row search has no hits", async () => {
    const gql = vi.fn(async () => ({
      workspace: { databaseSearch: [] },
    }));
    const session = createDatabaseRowsSession(gql);

    session.query("missing");
    await vi.waitFor(() => expect(session.isLoading$.value).toBe(false));

    expect(gql).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ query: databaseSearchQuery }),
    );
    expect(session.items$.value).toEqual([]);
    expect(session.error$.value).toBeNull();
  });
});

describe("recent and favorite discovery", () => {
  test("preserves mixed recent order while dropping trashed and stale targets", async () => {
    const visible = docRecord("visible");
    const trashed = docRecord("trashed", true);
    const recentItemsService = {
      getRecentDatabaseIds: () => ["database", "missing-database"],
      getRecentItems: () => [
        { id: "missing-doc", type: "doc" },
        { id: "database", type: "database" },
        { id: "trashed", type: "doc" },
        { id: "visible", type: "doc" },
        { id: "missing-database", type: "database" },
      ],
    };
    const gql = vi.fn(async () => ({
      workspace: {
        databases: [databaseSummary("database", "Database")],
      },
    }));
    const framework = new Framework();
    framework
      .service(RecentWorkspaceItemsService, recentItemsService as any)
      .service(DocsService, {
        list: { docs$: new LiveData([visible, trashed]) },
      } as any)
      .service(DocDisplayMetaService, {
        getDocDisplayMeta: (doc: { id: string }) => ({
          icon: undefined,
          title: doc.id,
          updatedDate: 42,
        }),
      } as any)
      .service(WorkspaceService, {
        workspace: { id: "workspace" },
      } as any)
      .service(WorkspaceServerService, { server: { gql } } as any)
      .entity(RecentTargetsQuickSearchSession, [
        RecentWorkspaceItemsService,
        DocsService,
        DocDisplayMetaService,
        WorkspaceService,
        WorkspaceServerService,
      ]);
    const session = framework
      .provider()
      .createEntity(RecentTargetsQuickSearchSession);

    session.query("");
    await vi.waitFor(() => expect(session.isLoading$.value).toBe(false));

    expect(session.items$.value.map((item) => item.id)).toEqual([
      "recent-target:database:database",
      "recent-target:doc:visible",
    ]);
  });

  test("keeps only resolvable favorite types in the stored order", async () => {
    const visible = docRecord("doc");
    const favorites = new LiveData([
      { id: "stale", index: "a", type: "doc" },
      { id: "database", index: "b", type: "database" },
      { id: "collection", index: "c", type: "collection" },
      { id: "archived", index: "d", type: "tag" },
      { id: "doc", index: "e", type: "doc" },
    ]);
    const gql = vi.fn(async () => ({
      workspace: {
        databases: [databaseSummary("database", "Database")],
      },
    }));
    const framework = new Framework();
    framework
      .service(FavoriteService, {
        favoriteList: {
          sortedList$: favorites,
        },
      } as any)
      .service(DocsService, {
        list: { docs$: new LiveData([visible]) },
      } as any)
      .service(DocDisplayMetaService, {
        getDocDisplayMeta: () => ({
          icon: undefined,
          title: "Document",
          updatedDate: 42,
        }),
      } as any)
      .service(CollectionService, {
        collectionMetas$: new LiveData([
          { id: "collection", name: "Collection" },
        ]),
      } as any)
      .service(TagService, {
        tagList: {
          tagMetas$: new LiveData([
            {
              archived: true,
              id: "archived",
              name: "Archived",
              updatedDate: 1,
            },
          ]),
        },
      } as any)
      .service(WorkspaceService, {
        workspace: { id: "workspace" },
      } as any)
      .service(WorkspaceServerService, { server: { gql } } as any)
      .entity(FavoritesQuickSearchSession, [
        FavoriteService,
        DocsService,
        DocDisplayMetaService,
        CollectionService,
        TagService,
        WorkspaceService,
        WorkspaceServerService,
      ]);
    const session = framework
      .provider()
      .createEntity(FavoritesQuickSearchSession);

    session.query("");
    await vi.waitFor(() => expect(session.isLoading$.value).toBe(false));

    expect(session.items$.value.map((item) => item.id)).toEqual([
      "favorite:database:database",
      "favorite:collection:collection",
      "favorite:doc:doc",
    ]);
  });
});
