import { DatabaseIcon, TagIcon, ViewLayersIcon } from "@myoxus/icons/react";
import { Entity, LiveData } from "@myoxus/infra";

import type { CollectionService } from "../../collection";
import type { DocsService } from "../../doc";
import type { DocDisplayMetaService } from "../../doc-display-meta";
import type { FavoriteService } from "../../favorite";
import type { WorkspaceServerService } from "../../server";
import type { TagService } from "../../tag";
import type { WorkspaceService } from "../../workspace";
import type { QuickSearchSession } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { databaseRoute, findDatabases } from "./database-discovery";

const FAVORITE_RESULT_LIMIT = 6;

const group = {
  id: "favorites",
  label: { i18nKey: "com.myoxus.rootAppSidebar.favorites" },
  score: 10,
} satisfies QuickSearchGroup;

export type FavoriteQuickSearchPayload =
  | { docId: string; route: string; type: "doc" }
  | { databaseId: string; route: string; type: "database" }
  | { collectionId: string; route: string; type: "collection" }
  | { tagId: string; route: string; type: "tag" };

export class FavoritesQuickSearchSession
  extends Entity
  implements QuickSearchSession<"favorites", FavoriteQuickSearchPayload>
{
  readonly group = group;
  constructor(
    private readonly favoriteService: FavoriteService,
    private readonly docsService: DocsService,
    private readonly docDisplayMetaService: DocDisplayMetaService,
    private readonly collectionService: CollectionService,
    private readonly tagService: TagService,
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
  }

  private readonly query$ = new LiveData("");
  private readonly databases$ = new LiveData(
    new Map<string, { id: string; title: string; updatedAt: string }>(),
  );
  readonly error$ = new LiveData<unknown>(null);
  readonly isLoading$ = new LiveData(false);

  readonly items$: LiveData<
    QuickSearchItem<"favorites", FavoriteQuickSearchPayload>[]
  > = LiveData.computed((get) => {
    if (get(this.query$)) return [];

    const favorites = get(this.favoriteService.favoriteList.sortedList$);
    const docs = new Map(
      get(this.docsService.list.docs$).map((doc) => [doc.id, doc]),
    );
    const collections = new Map(
      get(this.collectionService.collectionMetas$).map((collection) => [
        collection.id,
        collection,
      ]),
    );
    const tags = new Map(
      get(this.tagService.tagList.tagMetas$).map((tag) => [tag.id, tag]),
    );
    const databases = get(this.databases$);
    const items: QuickSearchItem<"favorites", FavoriteQuickSearchPayload>[] =
      [];

    for (const favorite of favorites) {
      if (favorite.type === "doc") {
        const doc = docs.get(favorite.id);
        if (!doc || get(doc.trash$)) continue;
        const { title, icon, updatedDate } =
          this.docDisplayMetaService.getDocDisplayMeta(doc);
        items.push({
          id: `favorite:doc:${doc.id}`,
          source: "favorites",
          group,
          label: { title },
          icon,
          timestamp: updatedDate,
          payload: {
            docId: doc.id,
            route: `/${encodeURIComponent(doc.id)}`,
            type: "doc",
          },
        });
      } else if (favorite.type === "database") {
        const database = databases.get(favorite.id);
        if (!database) continue;
        items.push({
          id: `favorite:database:${database.id}`,
          source: "favorites",
          group,
          label: {
            title: database.title || { i18nKey: "Untitled" },
          },
          icon: DatabaseIcon,
          timestamp: Date.parse(database.updatedAt),
          payload: {
            databaseId: database.id,
            route: databaseRoute(database.id),
            type: "database",
          },
        });
      } else if (favorite.type === "collection") {
        const collection = collections.get(favorite.id);
        if (!collection) continue;
        const search = new URLSearchParams({ collection: collection.id });
        items.push({
          id: `favorite:collection:${collection.id}`,
          source: "favorites",
          group,
          label: {
            title: collection.name || { i18nKey: "Untitled" },
          },
          icon: ViewLayersIcon,
          payload: {
            collectionId: collection.id,
            route: `/all?${search.toString()}`,
            type: "collection",
          },
        });
      } else if (favorite.type === "tag") {
        const tag = tags.get(favorite.id);
        if (!tag || tag.archived) continue;
        items.push({
          id: `favorite:tag:${tag.id}`,
          source: "favorites",
          group,
          label: { title: tag.name || { i18nKey: "Untitled" } },
          icon: TagIcon,
          timestamp:
            tag.updatedDate instanceof Date
              ? tag.updatedDate.getTime()
              : tag.updatedDate,
          payload: {
            route: `/tag/${encodeURIComponent(tag.id)}`,
            tagId: tag.id,
            type: "tag",
          },
        });
      }
      // Folder favorites deliberately remain owned by the structure tree.
      if (items.length === FAVORITE_RESULT_LIMIT) break;
    }
    return items;
  });

  private generation = 0;
  private controller: AbortController | null = null;
  private lastQuery = "";

  query(rawQuery: string) {
    this.lastQuery = rawQuery;
    const query = rawQuery.trim();
    this.query$.next(query);
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.error$.next(null);

    if (query) {
      this.databases$.next(new Map());
      this.isLoading$.next(false);
      return;
    }

    const databaseIds = this.favoriteService.favoriteList.sortedList$.value
      .filter((favorite) => favorite.type === "database")
      .map((favorite) => favorite.id);
    if (databaseIds.length === 0) {
      this.databases$.next(new Map());
      this.isLoading$.next(false);
      return;
    }
    if (this.workspaceService.workspace.flavour === "local") {
      this.databases$.next(new Map());
      this.isLoading$.next(false);
      return;
    }
    const server = this.workspaceServerService.server;
    if (!server) {
      this.databases$.next(new Map());
      this.error$.next(new Error("Workspace server is not available"));
      this.isLoading$.next(false);
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.isLoading$.next(true);
    void findDatabases(server, this.workspaceService.workspace.id, {
      databaseIds,
      first: databaseIds.length,
      signal: controller.signal,
    })
      .then((databases) => {
        if (generation !== this.generation) return;
        this.databases$.next(
          new Map(databases.map((database) => [database.id, database])),
        );
      })
      .catch((error) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.error$.next(error);
        this.databases$.next(new Map());
      })
      .finally(() => {
        if (generation === this.generation) {
          this.isLoading$.next(false);
        }
      });
  }

  retry = () => {
    this.query(this.lastQuery);
  };

  override dispose() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    super.dispose();
  }
}
