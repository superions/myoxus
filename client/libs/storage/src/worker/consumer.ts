import { OpConsumer } from "@myoxus/infra/op";
import { firstValueFrom, from, Observable, switchMap } from "rxjs";

import { type StorageConstructor } from "../impls";
import { classifyCloudWorkspaceDatabase } from "../impls/cloud/web-cloud-cache";
import { SpaceStorage } from "../storage";
import type { AwarenessRecord } from "../storage/awareness";
import { Sync } from "../sync";
import type { PeerStorageOptions } from "../sync/types";
import { TelemetryManager } from "../telemetry/manager";
import type { TelemetryContext } from "../telemetry/types";
import { MANUALLY_STOP } from "../utils/throw-if-aborted";
import type {
  ClientUpdateCacheResetReadiness,
  StoreInitOptions,
  WorkerManagerOps,
  WorkerOps,
} from "./ops";

export type { WorkerManagerOps };

class StoreConsumer {
  private readonly storages: PeerStorageOptions<SpaceStorage>;
  private readonly sync: Sync;

  get ensureLocal() {
    if (!this.storages) {
      throw new Error("Not initialized");
    }
    return this.storages.local;
  }

  get ensureSync() {
    if (!this.sync) {
      throw new Error("Sync not initialized");
    }
    return this.sync;
  }

  get docStorage() {
    return this.ensureLocal.get("doc");
  }

  get docSync() {
    return this.ensureSync.doc;
  }

  get blobStorage() {
    return this.ensureLocal.get("blob");
  }

  get blobSync() {
    return this.ensureSync.blob;
  }

  get docSyncStorage() {
    return this.ensureLocal.get("docSync");
  }

  get awarenessStorage() {
    return this.ensureLocal.get("awareness");
  }

  get awarenessSync() {
    return this.ensureSync.awareness;
  }

  get indexerStorage() {
    return this.ensureLocal.get("indexer");
  }

  get indexerSync() {
    return this.ensureSync.indexer;
  }

  constructor(
    private readonly availableStorageImplementations: StorageConstructor[],
    init: StoreInitOptions,
  ) {
    this.storages = {
      local: new SpaceStorage(
        Object.fromEntries(
          Object.entries(init.local).map(([type, opt]) => {
            if (opt === undefined) {
              return [type, undefined];
            }
            const Storage = this.availableStorageImplementations.find(
              (impl) => impl.identifier === opt.name,
            );
            if (!Storage) {
              throw new Error(`Storage implementation ${opt.name} not found`);
            }
            return [type, new Storage(opt.opts as any)];
          }),
        ),
      ),
      remotes: Object.fromEntries(
        Object.entries(init.remotes).map(([peer, opts]) => {
          return [
            peer,
            new SpaceStorage(
              Object.fromEntries(
                Object.entries(opts).map(([type, opt]) => {
                  if (opt === undefined) {
                    return [type, undefined];
                  }
                  const Storage = this.availableStorageImplementations.find(
                    (impl) => impl.identifier === opt.name,
                  );
                  if (!Storage) {
                    throw new Error(
                      `Storage implementation ${opt.name} not found`,
                    );
                  }
                  return [type, new Storage(opt.opts as any)];
                }),
              ),
            ),
          ];
        }),
      ),
    };
    this.sync = new Sync(this.storages);
    this.storages.local.connect();
    for (const remote of Object.values(this.storages.remotes)) {
      remote.connect();
    }
    this.sync.start();
  }

  bindConsumer(consumer: OpConsumer<WorkerOps>) {
    this.registerHandlers(consumer);
  }

  async destroy() {
    await this.sync?.stopAndWait();
    this.storages?.local.disconnect();
    await this.storages?.local.destroy();
    for (const remote of Object.values(this.storages?.remotes ?? {})) {
      remote.disconnect();
      await remote.destroy();
    }
  }

  async clientUpdateCacheResetReadiness(): Promise<ClientUpdateCacheResetReadiness> {
    const [doc, blob] = await Promise.all([
      firstValueFrom(this.docSync.state$),
      firstValueFrom(this.blobSync.state$),
    ]);
    return {
      ready: doc.synced && blob.uploading === 0 && blob.error === 0,
      pendingBlobs: blob.uploading + blob.error,
      pendingDocuments: doc.synced ? 0 : Math.max(doc.syncing, 1),
    };
  }

  private readonly ENABLE_BATTERY_SAVE_MODE_DELAY = 1000;
  private syncPauseTimeout: ReturnType<typeof setTimeout> | null = null;
  private syncPaused = false;

  private pauseSync() {
    if (this.syncPauseTimeout || this.syncPaused) {
      return;
    }
    this.syncPauseTimeout = setTimeout(() => {
      if (!this.syncPaused) {
        this.indexerSync.pauseSync();
        this.syncPaused = true;
        console.log("[IndexerSync] paused");
      }
    }, this.ENABLE_BATTERY_SAVE_MODE_DELAY);
  }

  private resumeSync() {
    if (this.syncPauseTimeout) {
      clearTimeout(this.syncPauseTimeout);
      this.syncPauseTimeout = null;
    }
    if (this.syncPaused) {
      this.indexerSync.resumeSync();
      this.syncPaused = false;
      console.log("[IndexerSync] resumed");
    }
  }

  private enableBatterySaveMode() {
    console.log("[IndexerSync] enable battery save mode");
    this.indexerSync.enableBatterySaveMode();
  }

  private disableBatterySaveMode() {
    console.log("[IndexerSync] disable battery save mode");
    this.indexerSync.disableBatterySaveMode();
  }

  private registerHandlers(consumer: OpConsumer<WorkerOps>) {
    const collectJobs = new Map<
      string,
      (awareness: AwarenessRecord | null) => void
    >();
    let collectId = 0;
    consumer.registerAll({
      "docStorage.getDoc": (docId: string) => this.docStorage.getDoc(docId),
      "docStorage.getDocDiff": ({ docId, state }) =>
        this.docStorage.getDocDiff(docId, state),
      "docStorage.pushDocUpdate": ({ update, origin }) =>
        this.docStorage.pushDocUpdate(update, origin),
      "docStorage.getDocTimestamps": (after) =>
        this.docStorage.getDocTimestamps(after ?? undefined),
      "docStorage.getDocTimestamp": (docId) =>
        this.docStorage.getDocTimestamp(docId),
      // This operation owns only the local cache. Authoritative cloud deletes
      // use the acknowledged GraphQL application path before local cleanup.
      "docStorage.deleteDoc": (docId: string) => this.docSync.deleteDoc(docId),
      "docStorage.subscribeDocDelete": (_, ctx) =>
        // Engine observers can register before IndexedDB has opened. RPC
        // cancellation also prevents attaching after the owning engine closes.
        from(this.docStorage.connection.waitForConnected(ctx.signal)).pipe(
          switchMap(
            () =>
              new Observable<string>((subscriber) =>
                this.docStorage.subscribeDocDelete?.((docId) =>
                  subscriber.next(docId),
                ),
              ),
          ),
        ),
      "docStorage.subscribeDocUpdate": () =>
        new Observable((subscriber) => {
          return this.docStorage.subscribeDocUpdate((update, origin) => {
            subscriber.next({ update, origin });
          });
        }),
      "docStorage.waitForConnected": (_, ctx) =>
        this.docStorage.connection.waitForConnected(ctx.signal),
      "blobStorage.getBlob": (key) => this.blobStorage.get(key),
      "blobStorage.setBlob": (blob) => this.blobStorage.set(blob),
      "blobStorage.deleteBlob": ({ key, permanently }) =>
        this.blobStorage.delete(key, permanently),
      "blobStorage.releaseBlobs": () => this.blobStorage.release(),
      "blobStorage.listBlobs": () => this.blobStorage.list(),
      "blobStorage.waitForConnected": (_, ctx) =>
        this.blobStorage.connection.waitForConnected(ctx.signal),
      "awarenessStorage.update": ({ awareness, origin }) =>
        this.awarenessStorage.update(awareness, origin),
      "awarenessStorage.subscribeUpdate": (docId) =>
        new Observable((subscriber) => {
          return this.awarenessStorage.subscribeUpdate(
            docId,
            (update, origin) => {
              subscriber.next({
                type: "awareness-update",
                awareness: update,
                origin,
              });
            },
            () => {
              const currentCollectId = collectId++;
              const promise = new Promise<AwarenessRecord | null>((resolve) => {
                collectJobs.set(currentCollectId.toString(), (awareness) => {
                  resolve(awareness);
                  collectJobs.delete(currentCollectId.toString());
                });
              });
              return promise;
            },
          );
        }),
      "awarenessStorage.collect": ({ collectId, awareness }) =>
        collectJobs.get(collectId)?.(awareness),
      "awarenessStorage.waitForConnected": (_, ctx) =>
        this.awarenessStorage.connection.waitForConnected(ctx.signal),
      "docSync.state": () => this.docSync.state$,
      "docSync.docState": (docId) =>
        new Observable((subscriber) => {
          const subscription = this.docSync
            .docState$(docId)
            .subscribe((state) => {
              subscriber.next(state);
            });
          return () => subscription.unsubscribe();
        }),
      "docSync.addPriority": ({ docId, priority }) =>
        new Observable(() => {
          const undo = this.docSync.addPriority(docId, priority);
          return () => undo();
        }),
      "docSync.waitForSynced": (docId, ctx) =>
        this.docSync.waitForSynced(docId ?? undefined, ctx.signal),
      "docSync.saveLocalUpdateAndWaitForSynced": ({ update, origin }, ctx) =>
        this.docSync.saveLocalUpdateAndWaitForSynced(
          update,
          origin,
          ctx.signal,
        ),
      "docSync.retryDoc": (docId) => this.docSync.retryDoc(docId),
      "docSync.resetSync": () => this.docSync.resetSync(),
      "blobSync.state": () => this.blobSync.state$,
      "blobSync.blobState": (blobId) => this.blobSync.blobState$(blobId),
      "blobSync.downloadBlob": (key) => this.blobSync.downloadBlob(key),
      "blobSync.uploadBlob": ({ blob, force }) =>
        this.blobSync.uploadBlob(blob, force),
      "blobSync.fullDownload": (peerId) =>
        new Observable((subscriber) => {
          const abortController = new AbortController();
          this.blobSync
            .fullDownload(peerId ?? undefined, abortController.signal)
            .then(() => {
              subscriber.next();
              subscriber.complete();
            })
            .catch((error) => {
              subscriber.error(error);
            });
          return () => abortController.abort(MANUALLY_STOP);
        }),
      "awarenessSync.update": ({ awareness, origin }) =>
        this.awarenessSync.update(awareness, origin),
      "awarenessSync.subscribeUpdate": (docId) =>
        new Observable((subscriber) => {
          const pending = new Set<string>();
          const unsubscribe = this.awarenessSync.subscribeUpdate(
            docId,
            (update, origin) => {
              subscriber.next({
                type: "awareness-update",
                awareness: update,
                origin,
              });
            },
            () => {
              const currentCollectId = collectId++;
              const key = currentCollectId.toString();
              pending.add(key);
              const promise = new Promise<AwarenessRecord | null>((resolve) => {
                collectJobs.set(key, (awareness) => {
                  collectJobs.delete(key);
                  pending.delete(key);
                  resolve(awareness);
                });
              });
              subscriber.next({
                type: "awareness-collect",
                collectId: currentCollectId.toString(),
              });
              return promise;
            },
          );
          // Closing a renderer must settle its in-flight collection promises;
          // the cloud subscription then discards them using its own generation.
          return () => {
            unsubscribe();
            for (const key of pending) collectJobs.get(key)?.(null);
          };
        }),
      "awarenessSync.collect": ({ collectId, awareness }) =>
        collectJobs.get(collectId)?.(awareness),
      "indexerSync.state": () => this.indexerSync.state$,
      "indexerSync.docState": (docId: string) =>
        this.indexerSync.docState$(docId),
      "indexerSync.addPriority": ({ docId, priority }) =>
        new Observable(() => {
          const undo = this.indexerSync.addPriority(docId, priority);
          return () => undo();
        }),
      "indexerSync.waitForCompleted": (_, ctx) =>
        this.indexerSync.waitForCompleted(ctx.signal),
      "indexerSync.waitForDocCompleted": (docId: string, ctx) =>
        this.indexerSync.waitForDocCompleted(docId, ctx.signal),
      "indexerSync.aggregate": ({ table, query, field, options }) =>
        this.indexerSync.aggregate(table, query, field, options),
      "indexerSync.search": ({ table, query, options }) =>
        this.indexerSync.search(table, query, options),
      "indexerSync.subscribeSearch": ({ table, query, options }) =>
        this.indexerSync.search$(table, query, options),
      "indexerSync.subscribeAggregate": ({ table, query, field, options }) =>
        this.indexerSync.aggregate$(table, query, field, options),
      "sync.enableBatterySaveMode": () => this.enableBatterySaveMode(),
      "sync.disableBatterySaveMode": () => this.disableBatterySaveMode(),
      "sync.pauseSync": () => this.pauseSync(),
      "sync.resumeSync": () => this.resumeSync(),
    });
  }
}

export class StoreManagerConsumer {
  private readonly storeDisposers = new Map<
    string,
    { dispose: () => Promise<void>; resettable: boolean }
  >();
  private readonly storePool = new Map<
    string,
    { store: StoreConsumer; refCount: number; resettable: boolean }
  >();
  private readonly telemetry = new TelemetryManager();

  constructor(
    private readonly availableStorageImplementations: StorageConstructor[],
  ) {}

  bindConsumer(consumer: OpConsumer<WorkerManagerOps>) {
    this.registerHandlers(consumer);
  }

  private registerHandlers(consumer: OpConsumer<WorkerManagerOps>) {
    // Each renderer port owns its telemetry identity. The shared worker must
    // not stamp events with whichever other tab last changed its context.
    let telemetryContext: TelemetryContext | undefined;
    consumer.registerAll({
      open: ({ port, key, closeKey, options }) => {
        console.debug("open store", key, closeKey);
        let storeRef = this.storePool.get(key);
        const resettable = classifyCloudWorkspaceDatabase(options) !== null;

        if (!storeRef) {
          const store = new StoreConsumer(
            this.availableStorageImplementations,
            options,
          );
          storeRef = { store, refCount: 0, resettable };
        } else if (storeRef.resettable !== resettable) {
          throw new Error(
            "Store key reused across incompatible cache-reset boundaries",
          );
        }
        storeRef.refCount++;

        const workerConsumer = new OpConsumer<WorkerOps>(port);
        storeRef.store.bindConsumer(workerConsumer);

        this.storeDisposers.set(closeKey, {
          resettable,
          dispose: async () => {
            // A tab/window close must detach its message consumer before the
            // shared store can be torn down. Otherwise in-flight operations may
            // keep running and report closed IndexedDB connections back into a
            // page that is already unloading or reloading.
            workerConsumer.destroy();
            storeRef.refCount--;
            if (storeRef.refCount === 0) {
              // Detach this generation before asynchronous teardown. A new open
              // must create its own store, which old cleanup must never remove.
              if (this.storePool.get(key) === storeRef)
                this.storePool.delete(key);
              await storeRef.store.destroy();
            }
          },
        });
        this.storePool.set(key, storeRef);
        return closeKey;
      },
      close: async (key) => {
        console.debug("close store", key);
        const workerDisposer = this.storeDisposers.get(key);
        if (!workerDisposer) {
          // Cache reset and concurrent view teardown can legitimately target
          // the same connection. Closing is idempotent once ownership has
          // already been removed from the worker.
          return;
        }
        // Claim the disposer before awaiting destruction so two concurrent
        // close requests cannot decrement the shared store reference twice.
        this.storeDisposers.delete(key);
        await workerDisposer.dispose();
      },
      "telemetry.setContext": (context) => {
        telemetryContext = context;
        return this.telemetry.setContext(context);
      },
      "telemetry.track": (event) =>
        telemetryContext
          ? this.telemetry.track(event, telemetryContext)
          : { queued: false },
      "telemetry.pageview": (event) =>
        telemetryContext
          ? this.telemetry.pageview(event, telemetryContext)
          : { queued: false },
      "telemetry.flush": () => this.telemetry.flush(),
      "telemetry.getQueueState": () => this.telemetry.getQueueState(),
      "clientUpdate.prepareCacheReset": async () => {
        const readiness = await Promise.all(
          [...this.storePool.values()]
            .filter(({ resettable }) => resettable)
            .map(({ store }) => store.clientUpdateCacheResetReadiness()),
        );
        const result = readiness.reduce<ClientUpdateCacheResetReadiness>(
          (combined, current) => ({
            ready: combined.ready && current.ready,
            pendingBlobs: combined.pendingBlobs + current.pendingBlobs,
            pendingDocuments:
              combined.pendingDocuments + current.pendingDocuments,
          }),
          {
            ready: true,
            pendingBlobs: 0,
            pendingDocuments: 0,
          },
        );
        if (!result.ready) return result;

        const disposers = [...this.storeDisposers.entries()].filter(
          ([, disposer]) => disposer.resettable,
        );
        for (const [key] of disposers) {
          this.storeDisposers.delete(key);
        }
        await Promise.all(disposers.map(([, disposer]) => disposer.dispose()));
        return result;
      },
    });
  }
}
