// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import {
  databasePageIdentitiesQuery,
  ServerDeploymentType,
  trashedDatabasePageIdentitiesQuery,
} from "@myoxus/graphql";
import { LiveData, Service } from "@myoxus/infra";
import { SocketConnection } from "@myoxus/storage/cloud";

import {
  DatabasePageLoadError,
  type DatabasePageRecord,
  loadDatabasePages,
} from "./database-page-loader";

export type DatabasePageLifecycle = "active" | "trashed";

export type DatabasePagesLoadState =
  | {
      status: "loading" | "refreshing";
      records: DatabasePageRecord[];
      failedOffset: null;
    }
  | { status: "ready"; records: DatabasePageRecord[]; failedOffset: null }
  | { status: "error"; records: DatabasePageRecord[]; failedOffset: number };

type LifecycleEntry = {
  readonly state$: LiveData<DatabasePagesLoadState>;
  confirmed: boolean;
  demand: number;
  generation: number;
  request: { controller: AbortController; promise: Promise<void> } | null;
};

function createEntry(): LifecycleEntry {
  return {
    state$: new LiveData<DatabasePagesLoadState>({
      status: "loading",
      records: [],
      failedOffset: null,
    }),
    confirmed: false,
    demand: 0,
    generation: 0,
    request: null,
  };
}

/**
 * Owns one canonical Database-page projection per workspace and lifecycle.
 * WorkspaceScope supplies server/account/workspace isolation; callers only
 * acquire demand and never maintain process-global workspace-ID caches.
 */
export class DatabasePagesService extends Service {
  private readonly entries: Record<DatabasePageLifecycle, LifecycleEntry> = {
    active: createEntry(),
    trashed: createEntry(),
  };
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
    if (typeof window !== "undefined") {
      const browserDocument = globalThis.document;
      const revalidate = () => {
        if (!browserDocument || browserDocument.visibilityState === "visible") {
          this.revalidateObserved();
        }
      };
      window.addEventListener("focus", revalidate);
      browserDocument?.addEventListener("visibilitychange", revalidate);
      this.disposers.push(() => {
        window.removeEventListener("focus", revalidate);
        browserDocument?.removeEventListener("visibilitychange", revalidate);
      });
    }

    const server = this.workspaceServerService.server;
    if (server?.config$?.value) {
      let connectedOnce = false;
      const connection = new SocketConnection(
        server.baseUrl,
        server.config$.value.type === ServerDeploymentType.Standalone,
        server.id,
      );
      const unsubscribe = connection.onStatusChanged((status) => {
        if (status !== "connected") return;
        if (connectedOnce) this.revalidateObserved();
        connectedOnce = true;
      });
      connection.connect();
      this.disposers.push(() => {
        unsubscribe();
        connection.disconnect();
      });
    }
  }

  state$(lifecycle: DatabasePageLifecycle) {
    return this.entries[lifecycle].state$;
  }

  acquire(lifecycle: DatabasePageLifecycle): () => void {
    const entry = this.entries[lifecycle];
    const resumed = entry.demand === 0;
    entry.demand += 1;
    if (!entry.confirmed) void this.load(lifecycle, 0, [], false);
    else if (resumed) void this.load(lifecycle, 0, [], true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.demand = Math.max(0, entry.demand - 1);
      if (entry.demand === 0 && entry.request) {
        entry.generation += 1;
        entry.request.controller.abort();
        entry.request = null;
      }
    };
  }

  /** Restart both lifecycle projections after any Database identity mutation. */
  invalidate() {
    for (const lifecycle of ["active", "trashed"] as const) {
      const entry = this.entries[lifecycle];
      entry.generation += 1;
      entry.request?.controller.abort();
      entry.request = null;
      if (entry.demand > 0) void this.load(lifecycle, 0, [], entry.confirmed);
      else entry.confirmed = false;
    }
  }

  reload(lifecycle: DatabasePageLifecycle) {
    const entry = this.entries[lifecycle];
    entry.generation += 1;
    entry.request?.controller.abort();
    entry.request = null;
    void this.load(lifecycle, 0, [], entry.confirmed);
  }

  retry(lifecycle: DatabasePageLifecycle) {
    const entry = this.entries[lifecycle];
    const state = entry.state$.value;
    if (state.status !== "error") return;
    void this.load(lifecycle, state.failedOffset, state.records, false);
  }

  private revalidateObserved() {
    for (const lifecycle of ["active", "trashed"] as const) {
      const entry = this.entries[lifecycle];
      if (entry.demand > 0 && entry.confirmed && !entry.request) {
        void this.load(lifecycle, 0, [], true);
      }
    }
  }

  private load(
    lifecycle: DatabasePageLifecycle,
    startOffset: number,
    existingRecords: readonly DatabasePageRecord[],
    background: boolean,
  ) {
    const entry = this.entries[lifecycle];
    if (this.disposed) return Promise.resolve();
    if (entry.request) return entry.request.promise;
    const generation = ++entry.generation;
    const controller = new AbortController();
    const retainedRecords = entry.state$.value.records;
    entry.state$.setValue({
      status: background ? "refreshing" : "loading",
      records: background ? retainedRecords : [...existingRecords],
      failedOffset: null,
    });
    const isCurrent = () =>
      !this.disposed &&
      generation === entry.generation &&
      !controller.signal.aborted;
    const promise = loadDatabasePages({
      existingRecords,
      startOffset,
      isCurrent,
      fetchPage: async (offset, first) => {
        const workspaceId = this.workspaceService.workspace.id;
        const server = this.workspaceServerService.server;
        if (!server) throw new Error("Workspace server is unavailable");
        const context = { signal: controller.signal };
        if (lifecycle === "trashed") {
          const response = await server.gql({
            query: trashedDatabasePageIdentitiesQuery,
            variables: { workspaceId, first, offset },
            context,
          });
          return response.workspace?.trashedDatabasePageIdentities ?? [];
        }
        const response = await server.gql({
          query: databasePageIdentitiesQuery,
          variables: { workspaceId, first, offset },
          context,
        });
        return response.workspace?.databasePageIdentities ?? [];
      },
      onPage: (records) => {
        if (!isCurrent() || background) return;
        entry.state$.setValue({
          status: "loading",
          records: [...records],
          failedOffset: null,
        });
      },
    })
      .then((records) => {
        if (!isCurrent()) return;
        entry.confirmed = true;
        entry.state$.setValue({ status: "ready", records, failedOffset: null });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const loadError =
          error instanceof DatabasePageLoadError ? error : undefined;
        const cause = loadError?.cause ?? error;
        const denied = [401, 403].some((status) =>
          UserFriendlyError.fromAny(cause).isStatus(status),
        );
        if (denied) entry.confirmed = false;
        entry.state$.setValue({
          status: "error",
          records: denied
            ? []
            : background
              ? retainedRecords
              : (loadError?.records ?? [...existingRecords]),
          failedOffset: loadError?.failedOffset ?? startOffset,
        });
      })
      .finally(() => {
        if (generation === entry.generation) entry.request = null;
      });
    entry.request = { controller, promise };
    return promise;
  }

  override dispose() {
    this.disposed = true;
    for (const entry of Object.values(this.entries)) {
      entry.generation += 1;
      entry.request?.controller.abort();
      entry.request = null;
      entry.confirmed = false;
      entry.state$.setValue({
        status: "loading",
        records: [],
        failedOffset: null,
      });
    }
    this.disposers.splice(0).forEach((dispose) => dispose());
    super.dispose();
  }
}
