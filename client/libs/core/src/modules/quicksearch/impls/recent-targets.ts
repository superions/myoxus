import { DatabaseIcon } from "@myoxus/icons/react";
import { Entity, LiveData } from "@myoxus/infra";

import type { DocsService } from "../../doc";
import type { DocDisplayMetaService } from "../../doc-display-meta";
import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import type { QuickSearchSession } from "../providers/quick-search-provider";
import type { RecentWorkspaceItemsService } from "../services/recent-workspace-items";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { databaseRoute, findDatabases } from "./database-discovery";

const RECENT_RESULT_LIMIT = 6;

const group = {
  id: "recent-targets",
  label: {
    i18nKey: "com.myoxus.cmdk.category.recent",
  },
  score: 20,
} satisfies QuickSearchGroup;

export type RecentTargetQuickSearchPayload =
  | { docId: string; route: string; type: "doc" }
  | { databaseId: string; route: string; type: "database" };

export class RecentTargetsQuickSearchSession
  extends Entity
  implements QuickSearchSession<"recent-target", RecentTargetQuickSearchPayload>
{
  readonly group = group;
  constructor(
    private readonly recentItemsService: RecentWorkspaceItemsService,
    private readonly docsService: DocsService,
    private readonly docDisplayMetaService: DocDisplayMetaService,
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
    QuickSearchItem<"recent-target", RecentTargetQuickSearchPayload>[]
  > = LiveData.computed((get) => {
    if (get(this.query$)) return [];

    const docs = get(this.docsService.list.docs$);
    const docsById = new Map(docs.map((doc) => [doc.id, doc]));
    const databases = get(this.databases$);
    const items: QuickSearchItem<
      "recent-target",
      RecentTargetQuickSearchPayload
    >[] = [];

    for (const recent of this.recentItemsService.getRecentItems()) {
      if (recent.type === "doc") {
        const doc = docsById.get(recent.id);
        if (!doc || get(doc.trash$)) continue;
        const { title, icon, updatedDate } =
          this.docDisplayMetaService.getDocDisplayMeta(doc);
        items.push({
          id: `recent-target:doc:${doc.id}`,
          source: "recent-target",
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
      } else {
        const database = databases.get(recent.id);
        if (!database) continue;
        items.push({
          id: `recent-target:database:${database.id}`,
          source: "recent-target",
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
      }
      if (items.length === RECENT_RESULT_LIMIT) break;
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

    const databaseIds = this.recentItemsService.getRecentDatabaseIds();
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
