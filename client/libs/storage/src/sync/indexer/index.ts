import { reserveAutomaticRetry } from "@myoxus/infra/retry";
import { omit } from "lodash-es";
import {
  filter,
  first,
  lastValueFrom,
  Observable,
  ReplaySubject,
  share,
  Subject,
  switchMap,
  throttleTime,
} from "rxjs";
import { applyUpdate, Doc as YDoc } from "yjs";

import {
  type AggregateOptions,
  type AggregateResult,
  type DocStorage,
  type IndexAvailability,
  IndexerDocument,
  type IndexerSchema,
  type IndexerStorage,
  type Query,
  type SearchOptions,
  type SearchResult,
} from "../../storage";
import { DummyIndexerStorage } from "../../storage/dummy/indexer";
import type { IndexerSyncStorage } from "../../storage/indexer-sync";
import { AsyncPriorityQueue } from "../../utils/async-priority-queue";
import { fromPromise } from "../../utils/from-promise";
import { takeUntilAbort } from "../../utils/take-until-abort";
import { MANUALLY_STOP, throwIfAborted } from "../../utils/throw-if-aborted";
import type { PeerStorageOptions } from "../types";
import { readAllDocsFromRootDoc } from "./root-doc-reader";

export type IndexerPreferOptions = "local" | "remote";

export function normalizeIndexerTitleField(title: unknown): string | undefined {
  if (typeof title === "string") {
    return title;
  }
  if (Array.isArray(title)) {
    return title.find((entry): entry is string => typeof entry === "string");
  }
  return undefined;
}

function describeIndexerError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: typeof error,
    message: String(error),
    stack: undefined,
  };
}

export interface IndexerSyncState {
  availability: IndexAvailability;
  paused: boolean;
  batterySaveMode: boolean;
  /**
   * Number of documents currently in the indexing queue
   */
  indexing: number;
  /**
   * Indicates whether all documents have been successfully indexed
   *
   * This is only for UI display purposes. For logical operations, please use `waitForCompleted()`
   */
  completed: boolean;
  /**
   * Total number of documents in the workspace
   */
  total: number;
  errorMessage: string | null;
}

export interface IndexerDocSyncState {
  /**
   * Indicates whether this document is currently in the indexing queue
   */
  indexing: boolean;
  /**
   * Indicates whether this document has been successfully indexed
   *
   * This is only for UI display purposes. For logical operations, please use `waitForDocCompleted()`
   */
  completed: boolean;
}

export interface IndexerSync {
  state$: Observable<IndexerSyncState>;
  docState$(docId: string): Observable<IndexerDocSyncState>;
  addPriority(docId: string, priority: number): () => void;
  waitForCompleted(signal?: AbortSignal): Promise<void>;
  waitForDocCompleted(docId: string, signal?: AbortSignal): Promise<void>;

  search<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O & { prefer?: IndexerPreferOptions },
  ): Promise<SearchResult<T, O>>;

  aggregate<T extends keyof IndexerSchema, const O extends AggregateOptions<T>>(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O & { prefer?: IndexerPreferOptions },
  ): Promise<AggregateResult<T, O>>;

  search$<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O & { prefer?: IndexerPreferOptions },
  ): Observable<SearchResult<T, O>>;

  aggregate$<
    T extends keyof IndexerSchema,
    const O extends AggregateOptions<T>,
  >(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O & { prefer?: IndexerPreferOptions },
  ): Observable<AggregateResult<T, O>>;
}

export class IndexerSyncImpl implements IndexerSync {
  private abort: AbortController | null = null;
  private run: Promise<void> | null = null;
  private readonly rootDocId = this.doc.spaceId;
  private readonly status = new IndexerSyncStatus(this.rootDocId);

  private readonly indexer: IndexerStorage;
  private readonly remote?: IndexerStorage;

  private lastRefreshed = Date.now();

  state$ = this.status.state$.pipe(
    // throttle the state to 1 second to avoid spamming the UI
    throttleTime(1000, undefined, {
      leading: true,
      trailing: true,
    }),
  );
  docState$(docId: string) {
    return this.status.docState$(docId).pipe(
      // throttle the state to 1 second to avoid spamming the UI
      throttleTime(1000, undefined, { leading: true, trailing: true }),
    );
  }

  async waitForCompleted(signal?: AbortSignal) {
    await lastValueFrom(
      this.status.state$.pipe(
        filter((state) => state.completed),
        takeUntilAbort(signal),
        first(),
      ),
    );
  }

  async waitForDocCompleted(docId: string, signal?: AbortSignal) {
    await lastValueFrom(
      this.status.docState$(docId).pipe(
        filter((state) => state.completed),
        takeUntilAbort(signal),
        first(),
      ),
    );
  }

  constructor(
    readonly doc: DocStorage,
    readonly peers: PeerStorageOptions<IndexerStorage>,
    readonly indexerSync: IndexerSyncStorage,
  ) {
    // sync feature only works on local indexer
    this.indexer = this.peers.local;
    this.remote = Object.values(this.peers.remotes).find((remote) => !!remote);
  }

  enableBatterySaveMode() {
    this.status.enableBatterySaveMode();
  }

  disableBatterySaveMode() {
    this.status.disableBatterySaveMode();
  }

  pauseSync() {
    this.status.pauseSync();
  }

  resumeSync() {
    this.status.resumeSync();
  }

  start() {
    if (this.run) return;

    const abort = new AbortController();
    this.abort = abort;

    const run = this.mainLoop(abort.signal)
      .catch((error) => {
        if (error !== MANUALLY_STOP) console.error("index error", error);
      })
      .finally(() => {
        if (this.run === run) this.run = null;
      });
    this.run = run;
  }

  stop() {
    this.abort?.abort(MANUALLY_STOP);
    this.abort = null;
  }

  async stopAndWait() {
    const run = this.run;
    this.stop();
    await run;
  }

  addPriority(id: string, priority: number) {
    return this.status.addPriority(id, priority);
  }

  private async mainLoop(signal?: AbortSignal) {
    if (this.indexer.isReadonly) {
      this.status.isReadonly = true;
      this.status.statusUpdatedSubject$.next(true);
      return;
    }

    while (!signal?.aborted) {
      try {
        await this.retryLoop(signal);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        if (this.status.availability === "failed") {
          this.status.errorMessage =
            error instanceof Error ? error.message : `${error}`;
          this.status.statusUpdatedSubject$.next(true);
          return;
        }
        if (this.status.availability === "rebuilding") {
          try {
            await this.indexer.failRebuild();
          } finally {
            // Search must remain fail-closed even when persisting the native
            // failure marker itself fails during storage teardown.
            this.status.availability = "failed";
          }
          this.status.errorMessage =
            error instanceof Error ? error.message : `${error}`;
          this.status.statusUpdatedSubject$.next(true);
          return;
        }
        console.error("index error, retry in 5s", error);
        this.status.errorMessage =
          error instanceof Error ? error.message : `${error}`;
        this.status.statusUpdatedSubject$.next(true);
      }

      this.status.reset();
      const retryAdmitted = await Promise.race([
        new Promise<boolean>((resolve) => {
          setTimeout(
            () => resolve(reserveAutomaticRetry("indexer-sync")),
            5000,
          );
        }),
        new Promise((_, reject) => {
          // exit if manually stopped
          if (signal?.aborted) {
            reject(signal.reason);
          }
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }),
      ]);
      if (!retryAdmitted) return;
    }
  }

  private async retryLoop(signal?: AbortSignal) {
    await Promise.race([
      Promise.all([
        this.doc.connection.waitForConnected(signal),
        this.indexer.connection.waitForConnected(signal),
        this.indexerSync.connection.waitForConnected(signal),
      ]),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Connect to remote timeout"));
        }, 1000 * 30);
      }),
      new Promise((_, reject) => {
        signal?.addEventListener("abort", (reason) => {
          reject(reason);
        });
      }),
    ]);

    this.status.errorMessage = null;
    this.status.statusUpdatedSubject$.next(true);

    const indexVersion = await this.indexer.indexVersion();
    this.status.availability = await this.indexer.indexState();
    this.status.statusUpdatedSubject$.next(true);
    if (this.status.availability === "failed") {
      this.status.errorMessage =
        "Search index temporarily unavailable (failed)";
      this.status.statusUpdatedSubject$.next(true);
      throw new Error(this.status.errorMessage);
    }
    console.log("indexer sync start, version: ", indexVersion);

    const unsubscribe = this.doc.subscribeDocUpdate((update) => {
      if (!this.status.rootDocReady) {
        return;
      }
      if (update.docId === this.rootDocId) {
        try {
          applyUpdate(this.status.rootDoc, update.bin);
        } catch (e) {
          console.warn(
            `[storage:indexer] applyUpdate failed for root doc update (${update.bin?.length ?? 0} bytes): ` +
              `${e instanceof Error ? e.message : String(e)}. Skipping this update.`,
          );
          return;
        }

        const allDocs = this.getAllDocsFromRootDoc();

        for (const [docId, { title }] of allDocs) {
          const existingDoc = this.status.docsInRootDoc.get(docId);
          if (!existingDoc) {
            this.status.scheduleJob(docId);
            this.status.docsInRootDoc.set(docId, { title });
            this.status.statusUpdatedSubject$.next(docId);
          } else {
            if (existingDoc.title !== title) {
              this.status.docsInRootDoc.set(docId, { title });
              this.status.statusUpdatedSubject$.next(docId);
            }
          }
        }

        for (const docId of this.status.docsInRootDoc.keys()) {
          if (!allDocs.has(docId)) {
            this.status.docsInRootDoc.delete(docId);
            this.status.statusUpdatedSubject$.next(docId);
          }
        }
        this.status.scheduleJob(this.rootDocId);
      } else {
        const docId = update.docId;
        const existingDoc = this.status.docsInRootDoc.get(docId);
        if (existingDoc) {
          this.status.scheduleJob(docId);
        }
      }
    });

    try {
      const rootDocBin = (await this.doc.getDoc(this.rootDocId))?.bin;
      if (rootDocBin) {
        try {
          applyUpdate(this.status.rootDoc, rootDocBin);
        } catch (e) {
          throw new Error(
            `Root document is not readable (${rootDocBin.length} bytes): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      this.status.scheduleJob(this.rootDocId);

      const allDocs = this.getAllDocsFromRootDoc();
      this.status.docsInRootDoc = allDocs;
      this.status.statusUpdatedSubject$.next(true);

      for (const docId of allDocs.keys()) {
        this.status.scheduleJob(docId);
      }

      this.status.rootDocReady = true;
      this.status.statusUpdatedSubject$.next(true);

      const allIndexedDocs =
        this.status.availability === "rebuilding"
          ? new Map<string, { title: string | undefined }>()
          : await this.getAllDocsFromIndexer();
      this.status.docsInIndexer = allIndexedDocs;
      this.status.statusUpdatedSubject$.next(true);

      while (true) {
        throwIfAborted(signal);

        const docId = await this.status.acceptJob(signal);
        await this.processAcceptedJob(docId, indexVersion, signal);
      }
    } finally {
      await this.refreshIfNeed();
      unsubscribe();
    }
  }

  private async processAcceptedJob(
    docId: string,
    indexVersion: number,
    signal?: AbortSignal,
  ) {
    let succeeded = false;
    try {
      if (docId === this.rootDocId) {
        await this.indexRootDocJob();
      } else {
        await this.indexDocJob(docId, indexVersion);
      }
      succeeded = true;
    } catch (error) {
      if (signal?.aborted || error === MANUALLY_STOP) {
        throw error;
      }

      if (docId === this.rootDocId) {
        console.error(
          "[storage:indexer] root document indexing failed",
          describeIndexerError(error),
        );
        throw error;
      }

      this.reportDocIndexFailure(docId, indexVersion, error);
      if (this.status.availability === "rebuilding") throw error;
    } finally {
      await this.refreshIfNeed();
      this.status.completeJob();
    }

    if (
      succeeded &&
      this.status.availability === "rebuilding" &&
      this.status.jobs.length() === 0 &&
      this.status.currentJob === null
    ) {
      await this.indexer.completeRebuild();
      this.status.availability = "ready";
      this.status.statusUpdatedSubject$.next(true);
    }
  }

  private async indexRootDocJob() {
    console.debug("[storage:indexer] indexing root document", this.rootDocId);

    for (const [docId, { title }] of this.status.docsInRootDoc) {
      const existingDoc = this.status.docsInIndexer.get(docId);
      if (existingDoc) {
        if (existingDoc.title !== title) {
          await this.indexer.update(
            "doc",
            IndexerDocument.from(docId, {
              docId,
              title,
            }),
          );
          this.status.docsInIndexer.set(docId, { title });
          this.status.statusUpdatedSubject$.next(docId);
        }
      } else {
        await this.indexer.insert(
          "doc",
          IndexerDocument.from(docId, {
            docId,
            title,
          }),
        );
        this.status.docsInIndexer.set(docId, { title });
        this.status.statusUpdatedSubject$.next(docId);
      }
    }

    for (const docId of this.status.docsInIndexer.keys()) {
      if (!this.status.docsInRootDoc.has(docId)) {
        await this.indexer.delete("doc", docId);
        await this.indexer.deleteByQuery("block", {
          type: "match",
          field: "docId",
          match: docId,
        });
        await this.indexerSync.clearDocIndexedClock(docId);
        this.status.docsInIndexer.delete(docId);
        this.status.statusUpdatedSubject$.next(docId);
      }
    }
  }

  private async indexDocJob(docId: string, indexVersion: number) {
    const existingDoc = this.status.docsInIndexer.get(docId);
    if (!existingDoc) {
      return;
    }

    const docClock = await this.doc.getDocTimestamp(docId);
    if (!docClock) {
      return;
    }

    const docIndexedClock = await this.indexerSync.getDocIndexedClock(docId);
    if (
      docIndexedClock &&
      docIndexedClock.timestamp.getTime() === docClock.timestamp.getTime() &&
      docIndexedClock.indexerVersion === indexVersion
    ) {
      return;
    }

    console.debug("[storage:indexer] indexing document", {
      docId,
      indexerVersion: indexVersion,
    });

    let blocks: IndexerDocument<"block">[] = [];
    let preview: string | undefined;

    const nativeResult = await this.tryNativeCrawlDocData(docId);
    if (nativeResult) {
      blocks = nativeResult.block;
      preview = nativeResult.summary;
    } else {
      const docBin = await this.doc.getDoc(docId);
      if (!docBin) {
        return;
      }

      const docYDoc = new YDoc({ guid: docId });
      try {
        applyUpdate(docYDoc, docBin.bin);
      } catch (error) {
        console.warn("[storage:indexer] document update is not readable", {
          docId,
          bytes: docBin.bin?.length ?? 0,
          ...describeIndexerError(error),
        });
        return;
      }

      const { crawlingDocData } = await import("./crawler");
      const result = await crawlingDocData({
        ydoc: docYDoc,
        rootYDoc: this.status.rootDoc,
        spaceId: this.status.rootDocId,
        docId,
      });

      if (result) {
        blocks = result.blocks;
        preview = result.preview;
      }
    }

    await this.indexer.deleteByQuery("block", {
      type: "match",
      field: "docId",
      match: docId,
    });

    for (const block of blocks) {
      await this.indexer.insert("block", block);
    }

    if (preview) {
      await this.indexer.update(
        "doc",
        IndexerDocument.from(docId, {
          summary: preview,
        }),
      );
    }

    await this.indexerSync.setDocIndexedClock({
      docId,
      timestamp: docClock.timestamp,
      indexerVersion: indexVersion,
    });

    console.debug("[storage:indexer] indexed document", {
      docId,
      indexerVersion: indexVersion,
      blocks: blocks.length,
      hasPreview: Boolean(preview),
    });
  }

  private reportDocIndexFailure(
    docId: string,
    indexVersion: number,
    error: unknown,
  ) {
    const details = describeIndexerError(error);
    console.warn("[storage:indexer] document indexing failed", {
      docId,
      indexerVersion: indexVersion,
      ...details,
    });
    this.status.errorMessage = details.message;
    this.status.statusUpdatedSubject$.next(docId);
  }

  // ensure the indexer is refreshed according to recommendRefreshInterval
  // recommendRefreshInterval <= 0 means force refresh on each operation
  // recommendRefreshInterval > 0 means refresh if the last refresh is older than recommendRefreshInterval
  private async refreshIfNeed(): Promise<void> {
    const recommendRefreshInterval = this.indexer.recommendRefreshInterval ?? 0;
    const needRefresh =
      recommendRefreshInterval > 0 &&
      this.lastRefreshed + recommendRefreshInterval < Date.now();
    const forceRefresh = recommendRefreshInterval <= 0;
    if (needRefresh || forceRefresh) {
      await this.indexer.refreshIfNeed();
      this.lastRefreshed = Date.now();
    }
  }

  /**
   * Get all docs from the root doc, without deleted docs
   */
  private getAllDocsFromRootDoc() {
    return readAllDocsFromRootDoc(this.status.rootDoc, {
      includeTrash: false,
    });
  }

  private async tryNativeCrawlDocData(docId: string) {
    try {
      const result = await this.doc.crawlDocData?.(docId);
      if (result) {
        return {
          title: result.title,
          block: result.blocks.map((block) =>
            IndexerDocument.from<"block">(`${docId}:${block.blockId}`, {
              docId,
              blockId: block.blockId,
              content: block.content,
              flavour: block.flavour,
              blob: block.blob,
              refDocId: block.refDocId,
              ref: block.refInfo,
              parentFlavour: block.parentFlavour,
              parentBlockId: block.parentBlockId,
              additional: block.additional,
            }),
          ),
          summary: result.summary,
        };
      }
      return null;
    } catch (error) {
      console.warn("[storage:indexer] native crawlDocData failed", {
        docId,
        ...describeIndexerError(error),
      });
      return null;
    }
  }

  private async getAllDocsFromIndexer() {
    const docs = await this.indexer.search(
      "doc",
      {
        type: "all",
      },
      {
        pagination: {
          limit: Infinity,
        },
        fields: ["docId", "title"],
      },
    );

    return new Map(
      docs.nodes.map((node) => {
        const title = node.fields.title;
        return [
          node.id,
          {
            title: normalizeIndexerTitleField(title),
          },
        ];
      }),
    );
  }

  async search<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O & { prefer?: IndexerPreferOptions },
  ): Promise<SearchResult<T, O>> {
    if (
      options?.prefer === "remote" &&
      this.remote &&
      !(this.remote instanceof DummyIndexerStorage)
    ) {
      await this.remote.connection.waitForConnected();
      return await this.remote.search(table, query, omit(options, "prefer"));
    } else {
      this.assertLocalIndexReady();
      await this.indexer.connection.waitForConnected();
      return await this.indexer.search(table, query, omit(options, "prefer"));
    }
  }

  async aggregate<
    T extends keyof IndexerSchema,
    const O extends AggregateOptions<T>,
  >(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O & { prefer?: IndexerPreferOptions },
  ): Promise<AggregateResult<T, O>> {
    if (
      options?.prefer === "remote" &&
      this.remote &&
      !(this.remote instanceof DummyIndexerStorage)
    ) {
      await this.remote.connection.waitForConnected();
      return await this.remote.aggregate(
        table,
        query,
        field,
        omit(options, "prefer"),
      );
    } else {
      this.assertLocalIndexReady();
      await this.indexer.connection.waitForConnected();
      return await this.indexer.aggregate(
        table,
        query,
        field,
        omit(options, "prefer"),
      );
    }
  }

  search$<T extends keyof IndexerSchema, const O extends SearchOptions<T>>(
    table: T,
    query: Query<T>,
    options?: O & { prefer?: IndexerPreferOptions },
  ): Observable<SearchResult<T, O>> {
    if (
      options?.prefer === "remote" &&
      this.remote &&
      !(this.remote instanceof DummyIndexerStorage)
    ) {
      const remote = this.remote;
      return fromPromise((signal) =>
        remote.connection.waitForConnected(signal),
      ).pipe(
        switchMap(() => remote.search$(table, query, omit(options, "prefer"))),
      );
    } else {
      return fromPromise((signal) =>
        this.waitForQueryableLocalIndex(signal),
      ).pipe(
        switchMap(() =>
          this.indexer.search$(table, query, omit(options, "prefer")),
        ),
      );
    }
  }

  aggregate$<
    T extends keyof IndexerSchema,
    const O extends AggregateOptions<T>,
  >(
    table: T,
    query: Query<T>,
    field: keyof IndexerSchema[T],
    options?: O & { prefer?: IndexerPreferOptions },
  ): Observable<AggregateResult<T, O>> {
    if (
      options?.prefer === "remote" &&
      this.remote &&
      !(this.remote instanceof DummyIndexerStorage)
    ) {
      const remote = this.remote;
      return fromPromise((signal) =>
        remote.connection.waitForConnected(signal),
      ).pipe(
        switchMap(() =>
          remote.aggregate$(table, query, field, omit(options, "prefer")),
        ),
      );
    } else {
      return fromPromise((signal) =>
        this.waitForQueryableLocalIndex(signal),
      ).pipe(
        switchMap(() =>
          this.indexer.aggregate$(table, query, field, omit(options, "prefer")),
        ),
      );
    }
  }

  private assertLocalIndexReady() {
    if (this.status.availability !== "ready") {
      throw new Error(
        `Search index temporarily unavailable (${this.status.availability})`,
      );
    }
  }

  private async waitForQueryableLocalIndex(signal?: AbortSignal) {
    await this.indexer.connection.waitForConnected(signal);
    if (this.status.availability === "rebuilding") {
      // Promise searches intentionally fail closed during an atomic rebuild.
      // Reactive searches back long-lived UI state, so terminating them here
      // would permanently poison the consuming LiveData. Keep the subscription
      // pending until the local index is either committed or marked failed.
      await lastValueFrom(
        this.status.state$.pipe(
          filter((state) => state.availability !== "rebuilding"),
          takeUntilAbort(signal),
          first(),
        ),
      );
    }
    this.assertLocalIndexReady();
  }
}

class IndexerSyncStatus {
  availability: IndexAvailability = "ready";
  isReadonly = false;
  prioritySettings = new Map<string, number>();
  jobs = new AsyncPriorityQueue();
  rootDoc = new YDoc({ guid: this.rootDocId });
  rootDocReady = false;
  docsInIndexer = new Map<string, { title: string | undefined }>();
  docsInRootDoc = new Map<string, { title: string | undefined }>();
  currentJob: string | null = null;
  errorMessage: string | null = null;
  statusUpdatedSubject$ = new Subject<string | true>();
  paused: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;
  batterySaveMode: boolean = false;

  state$ = new Observable<IndexerSyncState>((subscribe) => {
    const next = () => {
      if (this.isReadonly) {
        subscribe.next({
          availability: this.availability,
          indexing: 0,
          total: 0,
          errorMessage: this.errorMessage,
          completed: true,
          batterySaveMode: this.batterySaveMode,
          paused: this.paused !== null,
        });
      } else {
        subscribe.next({
          availability: this.availability,
          indexing: this.jobs.length() + (this.currentJob ? 1 : 0),
          total: this.docsInRootDoc.size + 1,
          errorMessage: this.errorMessage,
          completed:
            this.availability === "ready" &&
            this.rootDocReady &&
            this.jobs.length() === 0 &&
            this.currentJob === null,
          batterySaveMode: this.batterySaveMode,
          paused: this.paused !== null,
        });
      }
    };
    next();
    const dispose = this.statusUpdatedSubject$.subscribe(() => {
      next();
    });
    return () => {
      dispose.unsubscribe();
    };
  }).pipe(
    share({
      connector: () => new ReplaySubject(1),
    }),
  );

  docState$(docId: string) {
    return new Observable<IndexerDocSyncState>((subscribe) => {
      const next = () => {
        if (this.isReadonly) {
          subscribe.next({
            indexing: false,
            completed: this.availability === "ready",
          });
        } else {
          subscribe.next({
            indexing: this.jobs.has(docId) || this.currentJob === docId,
            completed:
              this.availability === "ready" &&
              this.docsInIndexer.has(docId) &&
              !this.jobs.has(docId) &&
              this.currentJob !== docId,
          });
        }
      };
      next();
      const dispose = this.statusUpdatedSubject$.subscribe((updatedDocId) => {
        if (updatedDocId === docId || updatedDocId === true) {
          next();
        }
      });
      return () => {
        dispose.unsubscribe();
      };
    }).pipe(
      share({
        connector: () => new ReplaySubject(1),
      }),
    );
  }

  constructor(readonly rootDocId: string) {
    this.prioritySettings.set(this.rootDocId, Infinity);
  }

  scheduleJob(docId: string) {
    const priority = this.prioritySettings.get(docId) ?? 0;
    this.jobs.push(docId, priority);
    this.statusUpdatedSubject$.next(docId);
  }

  async acceptJob(abort?: AbortSignal) {
    if (this.paused) {
      await this.paused.promise;
    }
    const job = await this.jobs.asyncPop(
      // if battery save mode is enabled, only accept jobs with priority > 1; otherwise accept all jobs
      this.batterySaveMode ? 1 : undefined,
      abort,
    );
    this.currentJob = job;
    this.statusUpdatedSubject$.next(job);
    return job;
  }

  completeJob() {
    const job = this.currentJob;
    this.currentJob = null;
    this.statusUpdatedSubject$.next(job ?? true);
  }

  addPriority(id: string, priority: number) {
    const oldPriority = this.prioritySettings.get(id) ?? 0;
    this.prioritySettings.set(id, priority);
    this.jobs.setPriority(id, oldPriority + priority);

    return () => {
      const currentPriority = this.prioritySettings.get(id) ?? 0;
      this.prioritySettings.set(id, currentPriority - priority);
      this.jobs.setPriority(id, currentPriority - priority);
    };
  }

  enableBatterySaveMode() {
    if (this.batterySaveMode) {
      return;
    }
    this.batterySaveMode = true;
    this.statusUpdatedSubject$.next(true);
  }

  disableBatterySaveMode() {
    if (!this.batterySaveMode) {
      return;
    }
    this.batterySaveMode = false;
    this.statusUpdatedSubject$.next(true);
  }

  pauseSync() {
    if (this.paused) {
      return;
    }
    this.paused = Promise.withResolvers();
    this.statusUpdatedSubject$.next(true);
  }

  resumeSync() {
    if (!this.paused) {
      return;
    }
    this.paused.resolve();
    this.paused = null;
    this.statusUpdatedSubject$.next(true);
  }

  reset() {
    // reset all state, except prioritySettings
    this.isReadonly = false;
    this.jobs.clear();
    this.docsInRootDoc.clear();
    this.docsInIndexer.clear();
    this.rootDoc = new YDoc({ guid: this.rootDocId });
    this.rootDocReady = false;
    this.currentJob = null;
    this.availability = "ready";
    this.batterySaveMode = false;
    this.paused = null;
    this.statusUpdatedSubject$.next(true);
  }
}
