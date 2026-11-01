import { groupBy } from "lodash-es";
import { nanoid } from "nanoid";
import {
  combineLatest,
  filter,
  first,
  lastValueFrom,
  map,
  Observable,
  ReplaySubject,
  share,
  Subject,
  throttleTime,
} from "rxjs";
import {
  applyUpdate,
  type Doc as YDoc,
  encodeStateAsUpdate,
  Map as YMap,
  mergeUpdates,
  type Transaction as YTransaction,
} from "yjs";

import type { DocRecord, DocStorage, PageRegistrationState } from "../storage";
import type { DocSync } from "../sync/doc";
import { AsyncPriorityQueue } from "../utils/async-priority-queue";
import { isEmptyUpdate } from "../utils/is-empty-update";
import { takeUntilAbort } from "../utils/take-until-abort";
import { MANUALLY_STOP, throwIfAborted } from "../utils/throw-if-aborted";

const STORAGE_ORIGIN = "storage-frontend";

type Job =
  | {
      type: "load";
      docId: string;
    }
  | {
      type: "save";
      docId: string;
      update: Uint8Array;
    }
  | {
      type: "apply";
      docId: string;
      update: Uint8Array;
    };

interface DocFrontendOptions {
  mergeUpdates?: (updates: Uint8Array[]) => Promise<Uint8Array> | Uint8Array;
}

export type DocFrontendDocState = {
  /**
   * some data is available in yjs doc instance
   */
  ready: boolean;
  /**
   * data is loaded from local doc storage and applied to yjs doc instance
   */
  loaded: boolean;
  /**
   * some data is being applied to yjs doc instance, or some data is being saved to local doc storage
   */
  updating: boolean;
  /**
   * the doc is syncing with remote peers
   */
  syncing: boolean;
  /**
   * the doc is synced with remote peers
   */
  synced: boolean;
  /**
   * the latest remote pull explicitly reported that the document was absent
   */
  remoteMissing: boolean;
  pageRegistration?: PageRegistrationState | null;
  /**
   * the doc is retrying to sync with remote peers
   */
  syncRetrying: boolean;
  /**
   * the error message when syncing with remote peers
   */
  syncErrorMessage: string | null;
};

export type DocFrontendState = {
  unregisteredDocs?: string[];
  /**
   * total number of docs
   */
  total: number;
  /**
   * number of docs that have been loaded to yjs doc instance
   */
  loaded: number;
  /**
   * some data is being applied to yjs doc instance, or some data is being saved to local doc storage
   */
  updating: boolean;
  /**
   * number of docs that are syncing with remote peers
   */
  syncing: number;
  /**
   * whether all docs are synced with remote peers
   */
  synced: boolean;
  /**
   * whether the doc is retrying to sync with remote peers
   */
  syncRetrying: boolean;
  /**
   * the error message when syncing with remote peers
   */
  syncErrorMessage: string | null;
};

export class DocFrontend {
  private readonly uniqueId = `frontend:${nanoid()}`;

  private readonly prioritySettings = new Map<string, number>();

  private readonly status = {
    docs: new Map<string, YDoc>(),
    connectedDocs: new Set<string>(),
    readyDocs: new Set<string>(),
    jobDocQueue: new AsyncPriorityQueue(),
    jobMap: new Map<string, Job[]>(),
    currentJob: null as { docId: string; jobs: Job[] } | null,
  };

  private readonly statusUpdatedSubject$ = new Subject<string>();

  private readonly abort = new AbortController();

  private readonly capturedLocalUpdates = new Map<string, Uint8Array[]>();

  constructor(
    public readonly storage: DocStorage,
    private readonly sync: DocSync,
    readonly options: DocFrontendOptions = {},
  ) {}

  private _docState$(docId: string): Observable<DocFrontendDocState> {
    const frontendState$ = new Observable<{
      ready: boolean;
      loaded: boolean;
      updating: boolean;
    }>((subscribe) => {
      const next = () => {
        subscribe.next({
          ready: this.status.readyDocs.has(docId),
          loaded: this.status.connectedDocs.has(docId),
          updating:
            (this.status.jobMap.get(docId)?.length ?? 0) > 0 ||
            this.status.currentJob?.docId === docId,
        });
      };
      next();
      return this.statusUpdatedSubject$.subscribe((updatedId) => {
        if (updatedId === docId) next();
      });
    });
    const syncState$ = this.sync.docState$(docId);
    return combineLatest([frontendState$, syncState$]).pipe(
      map(([frontend, sync]) => ({
        ...frontend,
        remoteMissing: sync.remoteMissing,
        pageRegistration: sync.pageRegistration,
        synced: sync.synced,
        syncing: sync.syncing,
        syncRetrying: sync.retrying,
        syncErrorMessage: sync.errorMessage,
      })),
    );
  }

  docState$(docId: string): Observable<DocFrontendDocState> {
    return this._docState$(docId).pipe(
      throttleTime(1000, undefined, {
        trailing: true,
        leading: true,
      }),
    );
  }

  private readonly _state$ = combineLatest([
    new Observable<{ total: number; loaded: number; updating: boolean }>(
      (subscriber) => {
        const next = () => {
          subscriber.next({
            total: this.status.docs.size,
            loaded: this.status.connectedDocs.size,
            updating:
              this.status.jobMap.size > 0 || this.status.currentJob !== null,
          });
        };
        next();
        return this.statusUpdatedSubject$.subscribe(() => {
          next();
        });
      },
    ),
    this.sync.state$,
  ]).pipe(
    map(([frontend, sync]) => ({
      total: sync.total ?? frontend.total,
      loaded: frontend.loaded,
      updating: frontend.updating,
      syncing: sync.syncing,
      synced: sync.synced,
      syncRetrying: sync.retrying,
      syncErrorMessage: sync.errorMessage,
      unregisteredDocs: sync.unregisteredDocs,
    })),
    share({
      connector: () => new ReplaySubject(1),
    }),
  ) satisfies Observable<DocFrontendState>;

  state$ = this._state$.pipe(
    throttleTime(1000, undefined, {
      leading: true,
      trailing: true,
    }),
  );

  start() {
    if (this.abort.signal.aborted) {
      throw new Error("doc frontend can only start once");
    }
    this.mainLoop(this.abort.signal).catch((error) => {
      if (error !== MANUALLY_STOP) {
        console.error(error);
      }
    });
  }

  stop() {
    this.abort.abort(MANUALLY_STOP);
  }

  private async mainLoop(signal?: AbortSignal) {
    await this.storage.connection.waitForConnected(signal);
    const dispose = this.storage.subscribeDocUpdate((record, origin) => {
      this.event.onStorageUpdate(record, origin);
    });
    const disposeDelete = this.storage.subscribeDocDelete?.((docId) =>
      this.detachDeletedDoc(docId),
    );
    try {
      while (true) {
        throwIfAborted(signal);

        const docId = await this.status.jobDocQueue.asyncPop(undefined, signal);
        const jobs = this.status.jobMap.get(docId);
        this.status.jobMap.delete(docId);

        if (!jobs) {
          this.statusUpdatedSubject$.next(docId);
          continue;
        }

        this.status.currentJob = { docId, jobs };
        this.statusUpdatedSubject$.next(docId);

        const { apply, load, save } = groupBy(jobs, (job) => job.type) as {
          [key in Job["type"]]?: Job[];
        };

        try {
          if (load?.length) {
            await this.jobs.load(load[0] as any, signal);
          }

          for (const applyJob of apply ?? []) {
            await this.jobs.apply(applyJob as any, signal);
          }

          if (save?.length) {
            await this.jobs.save(docId, save as any, signal);
          }
        } catch (error) {
          // The worker can reject a queued save after server-confirmed deletion.
          // Retire that leaf without stopping synchronization of other documents.
          if (!(error instanceof Error) || error.name !== "DOC_DELETED")
            throw error;
          this.detachDeletedDoc(docId);
        }

        this.status.currentJob = null;
        this.statusUpdatedSubject$.next(docId);
      }
    } finally {
      dispose();
      disposeDelete?.();
    }
  }

  /**
   * Connect a doc to the frontend, the doc will sync with the doc storage.
   * @param doc - The doc to connect
   */
  connectDoc(doc: YDoc) {
    this._connectDoc(doc);
  }

  readonly jobs = {
    load: async (job: Job & { type: "load" }, signal?: AbortSignal) => {
      const doc = this.status.docs.get(job.docId);
      if (!doc) {
        return;
      }
      const existingData = encodeStateAsUpdate(doc);

      if (!isEmptyUpdate(existingData)) {
        this.schedule({
          type: "save",
          docId: doc.guid,
          update: existingData,
        });
      }

      // mark doc as loaded
      doc.emit("sync", [true, doc]);

      const docRecord = await this.storage.getDoc(job.docId);
      throwIfAborted(signal);
      if (this.status.docs.get(job.docId) !== doc) return;

      if (docRecord && !isEmptyUpdate(docRecord.bin)) {
        this.applyUpdate(job.docId, docRecord.bin);

        this.status.readyDocs.add(job.docId);
      }

      this.status.connectedDocs.add(job.docId);
      this.statusUpdatedSubject$.next(job.docId);
    },
    save: async (
      docId: string,
      jobs: (Job & { type: "save" })[],
      signal?: AbortSignal,
    ) => {
      if (!this.status.docs.has(docId)) {
        return;
      }
      if (this.status.connectedDocs.has(docId)) {
        const merged = await this.mergeUpdates(
          jobs.map((j) => j.update).filter((update) => !isEmptyUpdate(update)),
        );
        throwIfAborted(signal);
        if (!this.status.docs.has(docId)) return;
        await this.storage.pushDocUpdate(
          {
            docId,
            bin: merged,
          },
          this.uniqueId,
        );
      }
    },
    apply: async (job: Job & { type: "apply" }, signal?: AbortSignal) => {
      throwIfAborted(signal);
      if (!this.status.docs.has(job.docId)) {
        return;
      }
      if (this.status.connectedDocs.has(job.docId)) {
        this.applyUpdate(job.docId, job.update);
      }
      if (!isEmptyUpdate(job.update)) {
        this.status.readyDocs.add(job.docId);
        this.statusUpdatedSubject$.next(job.docId);
      }
    },
  };

  event = {
    onStorageUpdate: (update: DocRecord, origin?: string) => {
      if (origin !== this.uniqueId) {
        this.schedule({
          type: "apply",
          docId: update.docId,
          update: update.bin,
        });
      }
    },
  };

  /**
   * Disconnect a doc from the frontend, the doc will stop syncing with the doc storage.
   * It's not recommended to use this method directly, better to use `doc.destroy()`.
   *
   * @param doc - The doc to disconnect
   */
  disconnectDoc(doc: YDoc) {
    this.status.docs.delete(doc.guid);
    this.status.connectedDocs.delete(doc.guid);
    this.status.readyDocs.delete(doc.guid);
    this.status.jobDocQueue.remove(doc.guid);
    this.status.jobMap.delete(doc.guid);
    this.statusUpdatedSubject$.next(doc.guid);
    doc.off("update", this.handleDocUpdate);
  }

  private detachDeletedDoc(docId: string) {
    const doc = this.status.docs.get(docId);
    if (doc) {
      this.disconnectDoc(doc);
    } else {
      this.status.jobDocQueue.remove(docId);
      this.status.jobMap.delete(docId);
      this.status.connectedDocs.delete(docId);
      this.status.readyDocs.delete(docId);
      this.statusUpdatedSubject$.next(docId);
    }
  }

  async deleteDoc(docId: string) {
    this.detachDeletedDoc(docId);
    await this.storage.deleteDoc(docId);
  }

  addPriority(id: string, priority: number) {
    const undoSyncPriority = this.sync?.addPriority(id, priority);
    const oldPriority = this.prioritySettings.get(id) ?? 0;

    this.prioritySettings.set(id, priority);
    this.status.jobDocQueue.setPriority(id, oldPriority + priority);

    return () => {
      const currentPriority = this.prioritySettings.get(id) ?? 0;
      this.prioritySettings.set(id, currentPriority - priority);
      this.status.jobDocQueue.setPriority(id, currentPriority - priority);

      undoSyncPriority?.();
    };
  }

  private _connectDoc(doc: YDoc) {
    if (this.status.docs.has(doc.guid)) {
      throw new Error("doc already connected");
    }
    this.schedule({
      type: "load",
      docId: doc.guid,
    });

    this.status.docs.set(doc.guid, doc);
    this.statusUpdatedSubject$.next(doc.guid);

    doc.on("update", this.handleDocUpdate);

    doc.on("destroy", () => {
      this.disconnectDoc(doc);
    });
  }

  private schedule(job: Job) {
    const priority = this.prioritySettings.get(job.docId) ?? 0;
    this.status.jobDocQueue.push(job.docId, priority);

    const existingJobs = this.status.jobMap.get(job.docId) ?? [];
    existingJobs.push(job);
    this.status.jobMap.set(job.docId, existingJobs);
    this.statusUpdatedSubject$.next(job.docId);
  }

  private isApplyingUpdate = false;

  applyUpdate(docId: string, update: Uint8Array) {
    const doc = this.status.docs.get(docId);
    if (doc && !isEmptyUpdate(update)) {
      try {
        this.isApplyingUpdate = true;
        applyUpdate(doc, update, STORAGE_ORIGIN);
      } catch (err) {
        console.error("failed to apply update yjs doc", err);
      } finally {
        this.isApplyingUpdate = false;
      }
    }
  }

  private readonly handleDocUpdate = (
    update: Uint8Array,
    origin: any,
    doc: YDoc,
    transaction: YTransaction,
  ) => {
    if (origin === STORAGE_ORIGIN) {
      return;
    }
    if (this.isApplyingUpdate && BUILD_CONFIG.debug) {
      let changedList = "";
      for (const [changed, keys] of transaction.changed) {
        for (const key of keys) {
          if (changed instanceof YMap && key) {
            changedList += `${key} => ${changed.get(key)}\n`;
          }
        }
      }
      console.warn(`⚠️ When storage applies a remote update, some code triggers a local change to the doc.
This will causes the document's 'edited by' to become the current user, even if the user has not actually modified the document.
This is usually caused by a coding error and needs to be fixed by the developer.
Changed:
${changedList}
`);
    }
    if (!this.status.docs.has(doc.guid)) {
      return;
    }

    const capturedUpdates = this.capturedLocalUpdates.get(doc.guid);
    if (capturedUpdates) {
      capturedUpdates.push(update);
      return;
    }

    this.schedule({
      type: "save",
      docId: doc.guid,
      update,
    });
  };

  protected mergeUpdates(updates: Uint8Array[]) {
    const merge = this.options?.mergeUpdates ?? mergeUpdates;

    return merge(updates.filter((bin) => !isEmptyUpdate(bin)));
  }

  async waitForUpdated(docId?: string, abort?: AbortSignal) {
    const source$: Observable<DocFrontendDocState | DocFrontendState> = docId
      ? this._docState$(docId)
      : this._state$;
    await lastValueFrom(
      source$.pipe(
        filter((status) => !status.updating),
        takeUntilAbort(abort),
        first(),
      ),
    );
    return;
  }

  /**
   * Persists the synchronous Yjs updates emitted by `update` directly to local
   * storage. This narrow boundary is independent of queued work for other docs;
   * remote synchronization continues through the storage worker as usual.
   */
  async updateAndWaitForSaved(docId: string, update: () => void) {
    if (!this.status.docs.has(docId) || !this.status.connectedDocs.has(docId)) {
      throw new Error(
        `Cannot persist an update for disconnected doc: ${docId}`,
      );
    }
    if (this.capturedLocalUpdates.has(docId)) {
      throw new Error(`Cannot nest local update persistence for doc: ${docId}`);
    }

    const updates: Uint8Array[] = [];
    this.capturedLocalUpdates.set(docId, updates);
    try {
      update();
    } catch (error) {
      updates.forEach((bin) => {
        this.schedule({ type: "save", docId, update: bin });
      });
      throw error;
    } finally {
      this.capturedLocalUpdates.delete(docId);
    }

    const meaningfulUpdates = updates.filter((bin) => !isEmptyUpdate(bin));
    if (meaningfulUpdates.length === 0) {
      return;
    }

    let merged: Uint8Array;
    try {
      merged = await this.mergeUpdates(meaningfulUpdates);
    } catch (error) {
      meaningfulUpdates.forEach((bin) => {
        this.schedule({ type: "save", docId, update: bin });
      });
      throw error;
    }

    await this.saveCapturedUpdateAndWaitForSaved(docId, merged);
  }

  /** Persist an already emitted nonempty update without reapplying it to Yjs.
   * This is a local durability boundary, independent of remote sync and unrelated
   * queued docs. Empty reapplication is not evidence that a failed update saved.
   * Copy before crossing storage transport, which may transfer/detach buffers. */
  async saveCapturedUpdateAndWaitForSaved(docId: string, update: Uint8Array) {
    if (!this.status.docs.has(docId) || !this.status.connectedDocs.has(docId))
      throw new Error(
        `Cannot persist an update for disconnected doc: ${docId}`,
      );
    if (isEmptyUpdate(update))
      throw new Error("Cannot persist an empty captured update");
    const retryUpdate = update.slice();
    try {
      await this.storage.pushDocUpdate(
        { docId, bin: update.slice() },
        this.uniqueId,
      );
    } catch (error) {
      this.schedule({ type: "save", docId, update: retryUpdate });
      throw error;
    }
  }

  /**
   * Persists an update which was emitted before this frontend had connected
   * the Y.Doc. Document creation uses this boundary so its subsequent remote
   * sync wait cannot observe the earlier idle state and overtake the first
   * materializing leaf write.
   */
  async saveDetachedUpdateAndWaitForSynced(
    docId: string,
    update: Uint8Array,
    abort?: AbortSignal,
  ): Promise<void> {
    if (isEmptyUpdate(update)) {
      return;
    }
    await this.sync.saveLocalUpdateAndWaitForSynced(
      { docId, bin: update.slice() },
      this.uniqueId,
      abort,
    );
  }

  async waitForDocLoaded(docId: string, abort?: AbortSignal) {
    await lastValueFrom(
      this._docState$(docId).pipe(
        filter((state) => state.loaded),
        takeUntilAbort(abort),
        first(),
      ),
    );
  }

  async waitForSynced(docId?: string, abort?: AbortSignal) {
    await this.waitForUpdated(docId, abort);
    await this.sync.waitForSynced(docId, abort);
  }

  async waitForDocReady(docId: string, abort?: AbortSignal) {
    await lastValueFrom(
      this._docState$(docId).pipe(
        filter((state) => state.ready),
        takeUntilAbort(abort),
        first(),
      ),
    );
  }

  async resetSync() {
    await this.sync.resetSync();
  }
}
