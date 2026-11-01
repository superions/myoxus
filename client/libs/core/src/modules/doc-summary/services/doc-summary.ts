import { ServerDeploymentType } from "@myoxus/graphql";
import {
  effect,
  fromPromise,
  LiveData,
  Service,
  smartRetry,
} from "@myoxus/infra";
import { SocketConnection } from "@myoxus/storage/cloud";
import { catchError, EMPTY, Observable, type Subscription, tap } from "rxjs";

import type { FeatureFlagService } from "../../feature-flag";
import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import type { DocSummaryStore } from "../stores/doc-summary";

type ListSnippetEntry = {
  readonly value$: LiveData<string | undefined>;
  demand: number;
  queued: boolean;
  inFlight: number;
  generation: number;
  indexedAt?: string;
  syncSubscription?: Subscription;
};

type ListSnippetRequest = {
  readonly controller: AbortController;
  readonly ids: string[];
  readonly generations: Map<string, number>;
};

export class DocSummaryService extends Service {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly store: DocSummaryStore,
    private readonly featureFlagService: FeatureFlagService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
    const storage = this.workspaceService.workspace.engine.doc.storage;
    this.disposers.push(
      storage.subscribeDocUpdate((update) =>
        this.revalidateVisible(update.docId, true),
      ),
    );
    if (storage.subscribeDocDelete) {
      this.disposers.push(
        storage.subscribeDocDelete((docId) => this.clearListSnippet(docId)),
      );
    }

    if (typeof window !== "undefined") {
      const browserDocument = globalThis.document;
      const revalidate = () => {
        if (!browserDocument || browserDocument.visibilityState === "visible") {
          this.revalidateVisible();
        }
      };
      window.addEventListener("focus", revalidate);
      window.addEventListener("online", revalidate);
      browserDocument?.addEventListener("visibilitychange", revalidate);
      this.disposers.push(() => {
        window.removeEventListener("focus", revalidate);
        window.removeEventListener("online", revalidate);
        browserDocument?.removeEventListener("visibilitychange", revalidate);
      });
    }

    const server = this.workspaceServerService.server;
    if (server?.account$) {
      let accountId = server.account$.value?.id;
      const subscription = server.account$.subscribe((account) => {
        const nextAccountId = account?.id;
        if (nextAccountId === accountId) return;
        accountId = nextAccountId;
        for (const request of this.listSnippetRequests) {
          request.controller.abort();
        }
        for (const entry of this.listSnippets.values()) {
          entry.generation += 1;
          entry.value$.setValue(undefined);
          entry.indexedAt = undefined;
          if (entry.demand > 0) entry.queued = true;
        }
        this.revalidateVisible();
      });
      this.disposers.push(() => subscription.unsubscribe());
    }
    if (server?.config$?.value) {
      let connectedOnce = false;
      const connection = new SocketConnection(
        server.baseUrl,
        server.config$.value.type === ServerDeploymentType.Standalone,
        server.id,
      );
      const unsubscribe = connection.onStatusChanged((status) => {
        if (status !== "connected") return;
        if (connectedOnce) this.revalidateVisible();
        connectedOnce = true;
      });
      connection.connect();
      this.disposers.push(() => {
        unsubscribe();
        connection.disconnect();
      });
    }
  }

  private readonly listSnippets = new Map<string, ListSnippetEntry>();
  private readonly listSnippetRequests = new Set<ListSnippetRequest>();
  private readonly disposers: Array<() => void> = [];
  private flushScheduled = false;
  private disposed = false;

  /**
   * Acquires the server search projection used by a visible Web list row.
   * It deliberately bypasses the local indexer and document-sync priorities.
   */
  watchVisibleListSnippet(docId: string) {
    return new Observable<string | undefined>((subscriber) => {
      const entry = this.getListSnippetEntry(docId);
      const resumed = entry.demand === 0;
      entry.demand += 1;
      if (resumed) {
        let syncing = false;
        entry.syncSubscription = this.workspaceService.workspace.engine.doc
          .docState$(docId)
          .subscribe((state) => {
            if (syncing && state.synced) this.revalidateVisible(docId, true);
            syncing = state.syncing;
          });
      }
      this.enqueueListSnippet(docId);
      const subscription = entry.value$.subscribe(subscriber);
      let released = false;
      return () => {
        subscription.unsubscribe();
        if (released) return;
        released = true;
        entry.demand = Math.max(0, entry.demand - 1);
        if (entry.demand === 0) {
          entry.syncSubscription?.unsubscribe();
          entry.syncSubscription = undefined;
        }
        this.abortUnobservedRequests();
      };
    });
  }

  private getListSnippetEntry(docId: string): ListSnippetEntry {
    let entry = this.listSnippets.get(docId);
    if (!entry) {
      entry = {
        value$: new LiveData<string | undefined>(undefined),
        demand: 0,
        queued: false,
        inFlight: 0,
        generation: 0,
      };
      this.listSnippets.set(docId, entry);
    }
    return entry;
  }

  private enqueueListSnippet(docId: string) {
    const entry = this.getListSnippetEntry(docId);
    if (this.disposed || entry.demand === 0) return;
    entry.queued = true;
    if (entry.inFlight > 0) return;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushListSnippets());
  }

  private flushListSnippets() {
    this.flushScheduled = false;
    if (this.disposed) return;
    const queued = [...this.listSnippets]
      .filter(([, entry]) => entry.queued && entry.demand > 0)
      .map(([docId, entry]) => {
        entry.queued = false;
        entry.inFlight += 1;
        return docId;
      });
    for (let offset = 0; offset < queued.length; offset += 100) {
      void this.loadListSnippets(queued.slice(offset, offset + 100));
    }
  }

  private async loadListSnippets(ids: string[]) {
    if (ids.length === 0) return;
    const request: ListSnippetRequest = {
      controller: new AbortController(),
      ids,
      generations: new Map(
        ids.map((docId) => [
          docId,
          this.listSnippets.get(docId)?.generation ?? 0,
        ]),
      ),
    };
    this.listSnippetRequests.add(request);
    try {
      const projections = await this.store.getDocumentSnippets(
        ids,
        request.controller.signal,
      );
      if (request.controller.signal.aborted || !projections) return;
      const byId = new Map(projections.map((value) => [value.docId, value]));
      for (const docId of ids) {
        const entry = this.listSnippets.get(docId);
        if (!entry || entry.generation !== request.generations.get(docId))
          continue;
        const projection = byId.get(docId);
        if (!projection) {
          // Omission means the identity is no longer readable or no longer exists.
          entry.value$.setValue(undefined);
          entry.indexedAt = undefined;
        } else if (projection.indexedAt !== undefined) {
          entry.value$.setValue(projection.snippet ?? "");
          entry.indexedAt = projection.indexedAt;
        }
        // A readable document without a search row retains known text only for
        // this workspace-scoped identity and is retried on the next demand.
      }
    } catch (error) {
      if (!request.controller.signal.aborted) console.error(error);
    } finally {
      this.listSnippetRequests.delete(request);
      for (const docId of ids) {
        const entry = this.listSnippets.get(docId);
        if (!entry) continue;
        entry.inFlight = Math.max(0, entry.inFlight - 1);
        if (entry.queued && entry.demand > 0) this.enqueueListSnippet(docId);
      }
    }
  }

  private revalidateVisible(docId?: string, fenceCurrent = false) {
    for (const [id, entry] of this.listSnippets) {
      if (entry.demand > 0 && (!docId || id === docId)) {
        if (fenceCurrent) entry.generation += 1;
        this.enqueueListSnippet(id);
      }
    }
  }

  private clearListSnippet(docId: string) {
    const entry = this.listSnippets.get(docId);
    if (!entry) return;
    entry.generation += 1;
    entry.value$.setValue(undefined);
    entry.indexedAt = undefined;
    entry.queued = false;
  }

  private abortUnobservedRequests() {
    for (const request of this.listSnippetRequests) {
      if (
        request.ids.every(
          (docId) => (this.listSnippets.get(docId)?.demand ?? 0) === 0,
        )
      ) {
        request.controller.abort();
      }
    }
  }

  private readonly docSummaryCache = new Map<
    string,
    Observable<string | undefined>
  >();

  watchDocSummary(docId: string, source: "auto" | "cloud" = "auto") {
    const key = `${source}:${docId}`;
    const cached$ = this.docSummaryCache.get(key);
    if (!cached$) {
      const ob$ = new Observable<string | undefined>((subscribe) => {
        if (
          source === "auto" &&
          (this.workspaceService.workspace.flavour === "local" ||
            this.featureFlagService.flags.enable_battery_save_mode.value ===
              false)
        ) {
          // use local indexer
          const sub = this.store
            .watchDocSummaryFromIndexer(docId)
            .subscribe(subscribe);
          return () => sub.unsubscribe();
        }
        // use cache, and revalidate from cloud
        const sub = this.store.watchDocSummaryCache(docId).subscribe(subscribe);
        this.revalidateDocSummaryFromCloud(docId);
        return () => sub.unsubscribe();
      });
      this.docSummaryCache.set(key, ob$);
      return ob$;
    }
    return cached$;
  }

  private readonly revalidateDocSummaryFromCloud = effect(
    (source$: Observable<string>) => {
      // make a lifo queue
      const queue: string[] = [];

      let currentTask: Subscription | undefined;

      const processTask = () => {
        if (currentTask) {
          return;
        }
        const docId = queue.pop();
        if (!docId) {
          return;
        }
        currentTask = fromPromise(this.store.getDocSummaryFromCloud(docId))
          .pipe(
            smartRetry(),
            tap((summary) => {
              if (summary !== undefined) {
                this.store.setDocSummaryCache(docId, summary).catch((error) => {
                  console.error(error);
                  // ignore error
                });
              }
            }),
            catchError((error) => {
              console.error(error);
              // ignore error
              return EMPTY;
            }),
          )
          .subscribe({
            complete() {
              currentTask = undefined;
              processTask();
            },
          });
      };

      return new Observable((subscriber) => {
        const sub = source$.subscribe({
          next: (value) => {
            queue.push(value);
            processTask();
          },
          complete: () => {
            subscriber.complete();
          },
        });
        return () => {
          sub.unsubscribe();
          currentTask?.unsubscribe();
        };
      });
    },
  );

  override dispose() {
    this.disposed = true;
    for (const request of this.listSnippetRequests) request.controller.abort();
    for (const entry of this.listSnippets.values()) {
      entry.syncSubscription?.unsubscribe();
    }
    for (const dispose of this.disposers.splice(0)) dispose();
    this.revalidateDocSummaryFromCloud.unsubscribe();
    super.dispose();
  }
}
