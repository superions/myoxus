import { DatabaseIcon } from "@myoxus/icons/react";
import { Entity, LiveData } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import type { QuickSearchSession } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { databaseRoute, findDatabases } from "./database-discovery";

const DATABASE_RESULT_LIMIT = 6;

const group = {
  id: "databases",
  label: { i18nKey: "com.myoxus.database.index.title" },
  score: 18,
} satisfies QuickSearchGroup;

export interface DatabaseQuickSearchPayload {
  databaseId: string;
  route: string;
}

export class DatabasesQuickSearchSession
  extends Entity
  implements QuickSearchSession<"databases", DatabaseQuickSearchPayload>
{
  readonly group = group;
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
  }

  readonly items$ = new LiveData<
    QuickSearchItem<"databases", DatabaseQuickSearchPayload>[]
  >([]);
  readonly error$ = new LiveData<unknown>(null);
  readonly isLoading$ = new LiveData(false);

  private generation = 0;
  private controller: AbortController | null = null;
  private lastQuery = "";

  query(rawQuery: string) {
    this.lastQuery = rawQuery;
    const query = rawQuery.trim();
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = null;
    this.error$.next(null);

    if (!query) {
      this.items$.next([]);
      this.isLoading$.next(false);
      return;
    }
    if (this.workspaceService.workspace.flavour === "local") {
      this.items$.next([]);
      this.isLoading$.next(false);
      return;
    }
    const server = this.workspaceServerService.server;
    if (!server) {
      this.items$.next([]);
      this.error$.next(new Error("Workspace server is not available"));
      this.isLoading$.next(false);
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.items$.next([]);
    this.isLoading$.next(true);

    void findDatabases(server, this.workspaceService.workspace.id, {
      first: DATABASE_RESULT_LIMIT,
      search: query,
      signal: controller.signal,
    })
      .then((databases) => {
        if (generation !== this.generation) return;
        this.items$.next(
          databases.map((database, index) => ({
            id: `database:${database.id}`,
            source: "databases",
            group,
            label: { title: database.title || { i18nKey: "Untitled" } },
            score: DATABASE_RESULT_LIMIT - index,
            icon: DatabaseIcon,
            timestamp: Date.parse(database.updatedAt),
            payload: {
              databaseId: database.id,
              route: databaseRoute(database.id),
            },
          })),
        );
      })
      .catch((error) => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.error$.next(error);
        this.items$.next([]);
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
