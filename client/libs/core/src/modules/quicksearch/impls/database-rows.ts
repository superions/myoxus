import { DatabaseTableViewIcon } from "@myoxus/icons/react";
import { Entity, LiveData } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import type { QuickSearchSession } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import {
  databaseRowRoute,
  findDatabaseRows,
  findDatabases,
} from "./database-discovery";

const DATABASE_ROW_RESULT_LIMIT = 6;

const group = {
  id: "database-rows",
  label: { i18nKey: "com.myoxus.database.rows.title" },
  score: 17,
} satisfies QuickSearchGroup;

export interface DatabaseRowQuickSearchPayload {
  databaseId: string;
  rowId: string;
  route: string;
}

export class DatabaseRowsQuickSearchSession
  extends Entity
  implements QuickSearchSession<"database-rows", DatabaseRowQuickSearchPayload>
{
  readonly group = group;
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
  }

  readonly items$ = new LiveData<
    QuickSearchItem<"database-rows", DatabaseRowQuickSearchPayload>[]
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
    const workspaceId = this.workspaceService.workspace.id;

    void findDatabaseRows(
      server,
      workspaceId,
      query,
      DATABASE_ROW_RESULT_LIMIT,
      controller.signal,
    )
      .then(async (hits) => {
        if (generation !== this.generation) return;
        if (hits.length === 0) {
          this.items$.next([]);
          return;
        }
        const databaseIds = [...new Set(hits.map((hit) => hit.databaseId))];
        let databaseTitles = new Map<string, string>();

        try {
          const databases = await findDatabases(server, workspaceId, {
            databaseIds,
            first: databaseIds.length,
            signal: controller.signal,
          });
          databaseTitles = new Map(
            databases.map((database) => [database.id, database.title]),
          );
        } catch (error) {
          if (generation !== this.generation || controller.signal.aborted) {
            return;
          }
          // Context enrichment is intentionally non-blocking: authorized row
          // hits retain their canonical route when database titles fail.
          this.error$.next(error);
        }

        if (generation !== this.generation) return;
        this.items$.next(
          hits.map((hit, index) => ({
            id: `database-row:${hit.databaseId}:${hit.rowId}`,
            source: "database-rows",
            group,
            label: {
              title: hit.title || { i18nKey: "Untitled" },
              subTitle: databaseTitles.get(hit.databaseId),
            },
            score: DATABASE_ROW_RESULT_LIMIT - index,
            icon: DatabaseTableViewIcon,
            timestamp: Date.parse(hit.updatedAt),
            payload: {
              databaseId: hit.databaseId,
              rowId: hit.rowId,
              route: databaseRowRoute(hit.databaseId, hit.rowId),
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
