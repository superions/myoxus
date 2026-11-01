import { DebugLogger } from "@myoxus/debug";
import {
  type DocumentMetadataValueDefinitionsQuery,
  type DocumentMetadataIndexQuery,
  type DocumentStatusSchemasQuery,
  type DocumentStatusValuesQuery,
  type DocumentTypesQuery,
  type WorkspaceDocumentSettingsQuery,
  documentMetadataIndexQuery,
  documentMetadataValueDefinitionsQuery,
  documentMetadataQuery,
  documentStatusSchemasQuery,
  documentStatusValuesQuery,
  documentTypesQuery,
  ServerDeploymentType,
  workspaceDocumentSettingsQuery,
} from "@myoxus/graphql";
import { LiveData, Service, Store } from "@myoxus/infra";
import { SocketConnection } from "@myoxus/storage/cloud";
import {
  defer,
  EMPTY,
  filter,
  Observable,
  switchMap,
  type Subscription,
} from "rxjs";

import { isDocumentNotFoundError } from "../../doc/errors";
import type { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import type { GuardService } from "../../permissions";
import type { GraphQLService, WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import type { TagStore } from "../../tag/stores/tag";
import {
  buildDocumentMetadataModel,
  type DocumentMetadataReferenceData,
  loadDocumentMetadataDocumentData,
  loadDocumentMetadataReferenceData,
  stateFromMetadata,
} from "../api";
import type { DocumentMetadata, DocumentMetadataModel } from "../types";

const logger = new DebugLogger("DocumentMetadataCache");

export type DocumentMetadataIndexRow =
  DocumentMetadataIndexQuery["documentMetadataIndex"][number];

export type DocumentMetadataIndexPhase =
  "unloaded" | "loading" | "ready" | "refreshing" | "error";

export interface DocumentMetadataIndexState {
  phase: DocumentMetadataIndexPhase;
  rows: DocumentMetadataIndexRow[];
  error: unknown | null;
  generation: number;
}

interface DocumentMetadataIndexRowLookup {
  byCanonicalId: ReadonlyMap<string, DocumentMetadataIndexRow>;
  byExternalId: ReadonlyMap<string, DocumentMetadataIndexRow>;
}

/**
 * Start shared index hydration without terminating list consumers on failure.
 * Only confirmed rows are emitted; the raw state remains available to the UI
 * for loading and error presentation while this stream waits for a retry.
 */
export function observeConfirmedDocumentMetadataIndex(
  cache: Pick<DocumentMetadataCacheService, "hydrateIndex" | "watchIndexState">,
) {
  return defer(() => {
    void cache.hydrateIndex().catch(() => {
      // The raw index state owns error reporting and explicit retry.
    });
    return cache.watchIndexState();
  }).pipe(
    filter(
      (state) =>
        state.rows.length > 0 ||
        state.phase === "ready" ||
        state.phase === "refreshing",
    ),
  );
}

export type DocumentMetadataLookupKey =
  "status" | "documentType" | "classification" | "version";

export interface DocumentMetadataIndexLookups {
  statusLabels: Record<string, string>;
  documentTypeLabels: Record<string, string>;
  classificationLabels: Record<string, string>;
  versionLabels: Record<string, string>;
  hydratedKeys: Partial<Record<DocumentMetadataLookupKey, boolean>>;
  hydratedAt?: string;
}

type CacheSource =
  | "documentMetadata"
  | "setDocumentMetadata"
  | "transitionDocumentStatus"
  | "refresh"
  | "documentMetadataIndex";

const EMPTY_LOOKUPS: DocumentMetadataIndexLookups = {
  statusLabels: {},
  documentTypeLabels: {},
  classificationLabels: {},
  versionLabels: {},
  hydratedKeys: {},
};

function mergeLookups(
  current: DocumentMetadataIndexLookups,
  next: Partial<DocumentMetadataIndexLookups>,
): DocumentMetadataIndexLookups {
  return {
    statusLabels: { ...current.statusLabels, ...next.statusLabels },
    documentTypeLabels: {
      ...current.documentTypeLabels,
      ...next.documentTypeLabels,
    },
    classificationLabels: {
      ...current.classificationLabels,
      ...next.classificationLabels,
    },
    versionLabels: { ...current.versionLabels, ...next.versionLabels },
    hydratedKeys: { ...current.hydratedKeys, ...next.hydratedKeys },
    hydratedAt: next.hydratedAt ?? current.hydratedAt,
  };
}

function normalizeLookups(
  lookups: DocumentMetadataIndexLookups | undefined,
): DocumentMetadataIndexLookups {
  return mergeLookups(EMPTY_LOOKUPS, lookups ?? {});
}

function labelsById(items: Array<{ id: string; label: string }>) {
  return Object.fromEntries(items.map((item) => [item.id, item.label]));
}

export class DocumentMetadataCacheStore extends Store {
  private readonly models = new Map<string, DocumentMetadataModel>();
  private readonly canonicalByAlias = new Map<string, string>();
  private readonly aliasesByCanonical = new Map<string, Set<string>>();
  private readonly modelStreams = new Map<
    string,
    LiveData<DocumentMetadataModel | null>
  >();
  private readonly staleReasons = new Map<string, string>();
  private readonly listModelOverrides = new Map<
    string,
    DocumentMetadataModel
  >();
  private readonly listModelOverrides$ = new LiveData<
    ReadonlyMap<string, DocumentMetadataModel>
  >(new Map());
  private readonly indexRows = new Map<string, DocumentMetadataIndexRow[]>();
  private readonly indexRowLookups = new Map<
    string,
    DocumentMetadataIndexRowLookup
  >();
  private readonly indexStreams = new Map<
    string,
    LiveData<DocumentMetadataIndexRow[]>
  >();
  private readonly indexStates = new Map<
    string,
    LiveData<DocumentMetadataIndexState>
  >();
  private readonly indexLookups = new Map<
    string,
    DocumentMetadataIndexLookups
  >();
  private readonly lookupStreams = new Map<
    string,
    LiveData<DocumentMetadataIndexLookups>
  >();

  getModel(docId: string): DocumentMetadataModel | null {
    const canonicalId = this.canonicalIdForRoute(docId);
    return canonicalId ? this.getCanonicalModel(canonicalId) : null;
  }

  canonicalIdForRoute(docId: string) {
    return this.canonicalByAlias.get(docId);
  }

  /** Metadata responses use SQL identities; editor readers use route aliases. */
  getCanonicalModel(docId: string): DocumentMetadataModel | null {
    return this.models.get(docId) ?? null;
  }

  watchModel(docId: string) {
    let stream = this.modelStreams.get(docId);
    if (!stream) {
      stream = new LiveData(this.getModel(docId));
      this.modelStreams.set(docId, stream);
    }
    return stream;
  }

  writeModel(model: DocumentMetadataModel, source: CacheSource) {
    const docId = model.metadata.docId;
    const current = this.models.get(docId);
    if (
      current?.metadata.projectionVersion ===
        model.metadata.projectionVersion &&
      current.metadata.metadataRevision > model.metadata.metadataRevision
    ) {
      return false;
    }

    if (
      !this.aliasesByCanonical.has(docId) &&
      !this.canonicalByAlias.has(docId)
    ) {
      this.registerAlias(docId, docId);
    }
    this.models.set(docId, model);
    const cacheKeys = [docId, ...(this.aliasesByCanonical.get(docId) ?? [])];
    for (const cacheKey of cacheKeys) {
      this.staleReasons.delete(cacheKey);
      this.modelStreams.get(cacheKey)?.next(this.getModel(cacheKey));
    }
    if (
      source === "setDocumentMetadata" ||
      source === "transitionDocumentStatus"
    ) {
      this.listModelOverrides.set(docId, model);
      this.publishListModelOverrides();
    }
    this.writeIndexLookups(
      model.metadata.workspaceId,
      mergeLookups(this.getIndexLookups(model.metadata.workspaceId), {
        statusLabels:
          model.state.statusId && model.state.statusLabel
            ? { [model.state.statusId]: model.state.statusLabel }
            : {},
        documentTypeLabels:
          model.state.typeId && model.state.typeLabel
            ? { [model.state.typeId]: model.state.typeLabel }
            : {},
        classificationLabels:
          model.state.classificationId && model.state.classificationLabel
            ? {
                [model.state.classificationId]: model.state.classificationLabel,
              }
            : {},
        versionLabels:
          model.state.currentVersionId && model.state.currentVersionLabel
            ? {
                [model.state.currentVersionId]: model.state.currentVersionLabel,
              }
            : {},
      }),
    );
    return true;
  }

  /**
   * Associate the workspace/editor document ID used by the client with the
   * canonical metadata UUID returned by the server. Models stay keyed only by
   * SQL identity: a route key may equal another live document's SQL UUID.
   */
  registerAlias(alias: string, canonicalId: string) {
    const previousCanonical = this.canonicalByAlias.get(alias);
    if (previousCanonical && previousCanonical !== canonicalId) {
      this.aliasesByCanonical.get(previousCanonical)?.delete(alias);
    }
    this.canonicalByAlias.set(alias, canonicalId);
    let aliases = this.aliasesByCanonical.get(canonicalId);
    if (!aliases) {
      aliases = new Set();
      this.aliasesByCanonical.set(canonicalId, aliases);
    }
    aliases.add(alias);

    const model = this.models.get(canonicalId);
    this.modelStreams.get(alias)?.next(model ?? null);
  }

  markStale(docId: string, reason: string) {
    this.staleReasons.set(docId, reason);
  }

  clearModel(docId: string) {
    const canonicalId = this.canonicalIdForRoute(docId);
    if (canonicalId) this.clearCanonicalModel(canonicalId);
  }

  private clearCanonicalModel(canonicalId: string) {
    this.models.delete(canonicalId);
    const cacheKeys = [
      canonicalId,
      ...(this.aliasesByCanonical.get(canonicalId) ?? []),
    ];
    for (const cacheKey of cacheKeys) {
      this.staleReasons.delete(cacheKey);
      this.modelStreams.get(cacheKey)?.next(this.getModel(cacheKey));
    }
    // Retain route bindings after deletion. Falling back to an equally spelled
    // SQL ID would expose a different live document through the deleted route.
    if (this.listModelOverrides.delete(canonicalId)) {
      this.publishListModelOverrides();
    }
  }

  getListModelOverride(docId: string): DocumentMetadataModel | null {
    const canonicalId = this.canonicalIdForRoute(docId);
    return canonicalId
      ? (this.listModelOverrides.get(canonicalId) ?? null)
      : null;
  }

  watchListModelOverrides() {
    return this.listModelOverrides$;
  }

  getIndexRows(workspaceId: string): DocumentMetadataIndexRow[] {
    return this.indexRows.get(workspaceId) ?? [];
  }

  getIndexRowByCanonicalId(workspaceId: string, docId: string) {
    return this.indexRowLookups.get(workspaceId)?.byCanonicalId.get(docId);
  }

  getIndexRowByExternalId(workspaceId: string, externalId: string) {
    return this.indexRowLookups.get(workspaceId)?.byExternalId.get(externalId);
  }

  watchIndexRows(workspaceId: string) {
    let stream = this.indexStreams.get(workspaceId);
    if (!stream) {
      stream = new LiveData(this.getIndexRows(workspaceId));
      this.indexStreams.set(workspaceId, stream);
    }
    return stream;
  }

  getIndexState(workspaceId: string): DocumentMetadataIndexState {
    return (
      this.indexStates.get(workspaceId)?.value ?? {
        phase: "unloaded",
        rows: this.getIndexRows(workspaceId),
        error: null,
        generation: 0,
      }
    );
  }

  watchIndexState(workspaceId: string) {
    let stream = this.indexStates.get(workspaceId);
    if (!stream) {
      stream = new LiveData(this.getIndexState(workspaceId));
      this.indexStates.set(workspaceId, stream);
    }
    return stream;
  }

  writeIndexState(workspaceId: string, state: DocumentMetadataIndexState) {
    this.indexStates.get(workspaceId)?.next(state);
    if (!this.indexStates.has(workspaceId)) {
      this.indexStates.set(workspaceId, new LiveData(state));
    }
  }

  writeIndexRows(workspaceId: string, rows: DocumentMetadataIndexRow[]) {
    const byCanonicalId = new Map<string, DocumentMetadataIndexRow>();
    const byExternalId = new Map<string, DocumentMetadataIndexRow>();
    for (const row of rows) {
      const canonicalId = String(row.docId);
      const rawExternalId = row.externalId;
      const externalId = rawExternalId ? String(rawExternalId) : null;
      if (!byCanonicalId.has(canonicalId)) {
        byCanonicalId.set(canonicalId, row);
      }
      if (externalId && !byExternalId.has(externalId)) {
        byExternalId.set(externalId, row);
      }
    }
    this.indexRowLookups.set(workspaceId, {
      byCanonicalId,
      byExternalId,
    });
    this.indexRows.set(workspaceId, rows);
    let removedOverride = false;
    for (const [docId, model] of this.listModelOverrides) {
      if (model.metadata.workspaceId === workspaceId) {
        this.listModelOverrides.delete(docId);
        removedOverride = true;
      }
    }
    if (removedOverride) this.publishListModelOverrides();
    this.indexStreams.get(workspaceId)?.next(rows);
  }

  clearIndexRows(workspaceId: string) {
    this.indexRows.delete(workspaceId);
    this.indexRowLookups.delete(workspaceId);
    this.indexStreams.get(workspaceId)?.next([]);
    this.indexStates.get(workspaceId)?.next({
      phase: "unloaded",
      rows: [],
      error: null,
      generation: 0,
    });
  }

  getIndexLookups(workspaceId: string): DocumentMetadataIndexLookups {
    return normalizeLookups(this.indexLookups.get(workspaceId));
  }

  watchIndexLookups(workspaceId: string) {
    let stream = this.lookupStreams.get(workspaceId);
    if (!stream) {
      stream = new LiveData(this.getIndexLookups(workspaceId));
      this.lookupStreams.set(workspaceId, stream);
    }
    return stream;
  }

  writeIndexLookups(
    workspaceId: string,
    lookups: DocumentMetadataIndexLookups,
  ) {
    this.indexLookups.set(workspaceId, lookups);
    this.lookupStreams.get(workspaceId)?.next(lookups);
  }

  clearWorkspace(workspaceId: string) {
    const canonicalIds = new Set(
      [...this.models.values()]
        .filter((model) => model.metadata.workspaceId === workspaceId)
        .map((model) => model.metadata.docId),
    );
    for (const docId of canonicalIds) {
      this.clearCanonicalModel(docId);
    }
    this.staleReasons.clear();
    this.indexRows.delete(workspaceId);
    this.indexRowLookups.delete(workspaceId);
    this.indexStreams.get(workspaceId)?.next([]);
    this.indexStates.get(workspaceId)?.next({
      phase: "unloaded",
      rows: [],
      error: null,
      generation: 0,
    });
    this.indexLookups.delete(workspaceId);
    this.lookupStreams.get(workspaceId)?.next(normalizeLookups(undefined));
  }

  override dispose() {
    this.models.clear();
    this.canonicalByAlias.clear();
    this.aliasesByCanonical.clear();
    this.staleReasons.clear();
    this.listModelOverrides.clear();
    this.publishListModelOverrides();
    this.indexRows.clear();
    this.indexRowLookups.clear();
    this.indexLookups.clear();
    for (const stream of this.modelStreams.values()) stream.next(null);
    for (const stream of this.indexStreams.values()) stream.next([]);
    for (const stream of this.indexStates.values()) {
      stream.next({
        phase: "unloaded",
        rows: [],
        error: null,
        generation: 0,
      });
    }
    this.indexStates.clear();
    for (const stream of this.lookupStreams.values()) {
      stream.next(normalizeLookups(undefined));
    }
    this.modelStreams.clear();
    this.indexStreams.clear();
    this.lookupStreams.clear();
    super.dispose();
  }

  private publishListModelOverrides() {
    this.listModelOverrides$.next(new Map(this.listModelOverrides));
  }
}

export class DocumentMetadataCacheService extends Service {
  private readonly lifecycleSubscription: Subscription;
  private readonly revalidationDisposers: Array<() => void> = [];
  private activeRequests = 0;
  private readonly requestWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }> = [];
  private readonly modelHydrations = new Map<
    string,
    Promise<DocumentMetadataModel>
  >();
  private referenceData: DocumentMetadataReferenceData | null = null;
  private readonly pendingMetadata = new Map<string, DocumentMetadata>();
  private referenceHydration: Promise<DocumentMetadataReferenceData> | null =
    null;
  private indexHydration: Promise<DocumentMetadataIndexRow[]> | null = null;
  private indexHydrationGeneration: number | null = null;
  private lookupHydration: Promise<DocumentMetadataIndexLookups> | null = null;
  private indexHydrated = false;
  private indexGeneration = 0;
  private lookupsHydrated = false;
  private lifecycleGeneration = 0;

  constructor(
    private readonly store: DocumentMetadataCacheStore,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly workspaceService: WorkspaceService,
    private readonly documentLifecycle: DocumentLifecycleStore,
    private readonly guardService: GuardService,
    private readonly tagStore: TagStore,
  ) {
    super();
    this.lifecycleSubscription = this.documentLifecycle.notFound$.subscribe(
      (docId) => {
        this.store.clearModel(docId);
        const canonicalId = this.store.canonicalIdForRoute(docId);
        if (canonicalId) this.pendingMetadata.delete(canonicalId);
        this.modelHydrations.delete(docId);
        // Invalidating an unloaded index emits its generation without loading
        // it, so bounded consumers can also fence a terminal lifecycle change.
        this.invalidateIndex("document-lifecycle");
      },
    );
    if (typeof window !== "undefined") {
      const browserDocument = globalThis.document;
      const revalidate = () => {
        if (
          this.getIndexState().phase !== "unloaded" &&
          (!browserDocument || browserDocument.visibilityState === "visible")
        ) {
          this.invalidateIndex("workspace-resumed");
        }
      };
      window.addEventListener("focus", revalidate);
      window.addEventListener("online", revalidate);
      browserDocument?.addEventListener("visibilitychange", revalidate);
      this.revalidationDisposers.push(() => {
        window.removeEventListener("focus", revalidate);
        window.removeEventListener("online", revalidate);
        browserDocument?.removeEventListener("visibilitychange", revalidate);
      });
    }
    const server = this.workspaceServerService.server;
    if (server && typeof server.baseUrl === "string" && server.config$?.value) {
      let connectedOnce = false;
      const connection = new SocketConnection(
        server.baseUrl,
        server.config$.value.type === ServerDeploymentType.Standalone,
        server.id,
      );
      const unsubscribe = connection.onStatusChanged((status) => {
        if (status !== "connected") return;
        if (connectedOnce && this.getIndexState().phase !== "unloaded") {
          this.invalidateIndex("socket-reconnected");
        }
        connectedOnce = true;
      });
      connection.connect();
      this.revalidationDisposers.push(() => {
        unsubscribe();
        connection.disconnect();
      });
    }
  }

  getModel(docId: string) {
    return this.store.getModel(docId);
  }

  /**
   * Return an acknowledged metadata write that may temporarily lead the last
   * confirmed list index. The next accepted index generation clears it.
   */
  getListModelOverride(docId: string) {
    return this.store.getListModelOverride(docId);
  }

  watchListModelOverrides() {
    return this.store.watchListModelOverrides();
  }

  /**
   * Keep an open document's clean named head current after content sync ACKs.
   * Yjs edits never assign canonical dirty state locally. Once the server has
   * reported dirty, further keystrokes need no additional metadata requests.
   * The Doc entity owns this subscription; closing it cancels pending reads.
   */
  observeSyncedVersionHead(docId: string): () => void {
    const workspace = this.workspaceService.workspace;
    if (workspace.flavour === "local") return () => {};

    const subscription = workspace.engine.doc
      .docState$(docId)
      .pipe(
        switchMap((sync) => {
          const state = this.getModel(docId)?.state;
          if (
            !sync.synced ||
            !state?.currentVersionId ||
            state.dirtySinceCurrentVersion
          )
            return EMPTY;

          return new Observable<void>((observer) => {
            const abort = new AbortController();
            void this.hydrateMetadata(docId, abort.signal, {
              refresh: true,
            }).then(
              () => observer.complete(),
              (error: unknown) => {
                if (!abort.signal.aborted) {
                  this.markStale(docId, "content-sync-refresh-failed");
                  logger.error(
                    "Version head refresh after content sync failed",
                    error,
                  );
                }
                observer.complete();
              },
            );
            return () => abort.abort();
          });
        }),
      )
      .subscribe();
    return () => subscription.unsubscribe();
  }

  /**
   * Read canonical facts without hydrating editor lookups (notably members).
   * Reuse the same model/pending-metadata cache; this is not a second metadata
   * projection or an implicit UsersRead dependency for creation timestamps.
   */
  async hydrateMetadata(
    docId: string,
    attemptSignal?: AbortSignal,
    options: { refresh?: boolean } = {},
  ) {
    this.assertServerBackedWorkspace();
    const signal = this.documentLifecycle.requestSignal(docId, attemptSignal);
    const cached =
      this.store.getModel(docId)?.metadata ??
      this.pendingMetadataForRoute(docId);
    // Context reads can require current Read/trash authority. Refresh still
    // updates this one cache, rather than creating a separate metadata owner.
    if (cached && !options.refresh) return cached;
    const generation = this.lifecycleGeneration;
    try {
      const response = await this.limitedGraphqlService(signal).gql({
        query: documentMetadataQuery,
        variables: { workspaceId: this.workspaceService.workspace.id, docId },
        context: { signal },
      });
      signal.throwIfAborted();
      const metadata = response.documentMetadata;
      if (generation === this.lifecycleGeneration) {
        this.store.registerAlias(docId, metadata.docId);
        this.writeMetadata(metadata, "documentMetadata", docId);
      }
      return metadata;
    } catch (error) {
      if (isDocumentNotFoundError(error))
        this.documentLifecycle.markNotFound(docId);
      throw error;
    }
  }

  watchModel(docId: string) {
    return this.store.watchModel(docId);
  }

  writeModel(
    model: DocumentMetadataModel,
    source: CacheSource,
    docId = model.metadata.docId,
  ) {
    if (!this.documentLifecycle.isAvailable(docId)) {
      return false;
    }
    this.pendingMetadata.delete(model.metadata.docId);
    return this.store.writeModel(model, source);
  }

  writeMetadata(
    metadata: DocumentMetadata,
    source: CacheSource,
    docId = metadata.docId,
  ) {
    if (!this.documentLifecycle.isAvailable(docId)) {
      return null;
    }
    const current = this.store.getCanonicalModel(metadata.docId);
    if (!current) {
      this.rememberPendingMetadata(metadata.docId, metadata);
      return null;
    }
    const next = {
      ...current,
      metadata,
      state: stateFromMetadata(metadata),
    };
    this.pendingMetadata.delete(metadata.docId);
    return this.store.writeModel(next, source) ? next : current;
  }

  async writeMetadataForDocument(
    docId: string,
    metadata: DocumentMetadata,
    source: CacheSource,
  ) {
    this.assertDocumentAvailable(docId);
    this.store.registerAlias(docId, metadata.docId);
    if (this.store.getModel(docId)) {
      return this.writeMetadata(metadata, source, docId);
    }

    this.rememberPendingMetadata(metadata.docId, metadata);
    const model = await this.hydrateModel(docId, { refresh: true });
    this.store.writeModel(model, source);
    return model;
  }

  markStale(docId: string, reason: string) {
    this.store.markStale(docId, reason);
  }

  async hydrateModel(docId: string, options: { refresh?: boolean } = {}) {
    this.assertServerBackedWorkspace();
    this.assertDocumentAvailable(docId);
    const cached = this.store.getModel(docId);
    if (cached && !options.refresh) return cached;

    const running = this.modelHydrations.get(docId);
    if (running) return running;

    const generation = this.lifecycleGeneration;
    const hydration = this.hydrateModelOnce(docId, generation).finally(() => {
      if (this.modelHydrations.get(docId) === hydration) {
        this.modelHydrations.delete(docId);
      }
    });
    this.modelHydrations.set(docId, hydration);
    return hydration;
  }

  async hydrateModels(docIds: string[]) {
    const pending = [...new Set(docIds)];
    const models = new Map<string, DocumentMetadataModel>();
    const errors: unknown[] = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < pending.length) {
        const docId = pending[cursor++];
        try {
          models.set(docId, await this.hydrateModel(docId));
        } catch (error) {
          // hydrateModel marks a server-confirmed missing document terminal.
          // Bulk list projections omit only that stale index entry; unrelated
          // failures remain visible and fail the complete hydration request.
          if (this.documentLifecycle.isAvailable(docId)) {
            errors.push(error);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(8, pending.length) }, () => worker()),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Document metadata hydration failed");
    }
    return models;
  }

  private async hydrateModelOnce(docId: string, generation: number) {
    const signal = this.documentLifecycle.signal(docId);
    const server = this.limitedGraphqlService(signal);
    const workspaceId = this.workspaceService.workspace.id;
    let document: Awaited<ReturnType<typeof loadDocumentMetadataDocumentData>>;
    let references: DocumentMetadataReferenceData;
    try {
      [document, references] = await Promise.all([
        loadDocumentMetadataDocumentData(server, workspaceId, docId, signal),
        this.hydrateReferenceData(),
      ]);
    } catch (error) {
      if (isDocumentNotFoundError(error)) {
        this.documentLifecycle.markNotFound(docId);
        this.store.clearModel(docId);
        const canonicalId = this.store.canonicalIdForRoute(docId);
        if (canonicalId) this.pendingMetadata.delete(canonicalId);
      }
      throw error;
    }
    this.assertDocumentAvailable(docId);
    const pendingMetadata = this.pendingMetadata.get(document.metadata.docId);
    const effectiveDocument =
      pendingMetadata &&
      (pendingMetadata.projectionVersion !==
        document.metadata.projectionVersion ||
        pendingMetadata.metadataRevision >= document.metadata.metadataRevision)
        ? { ...document, metadata: pendingMetadata }
        : document;
    const model = buildDocumentMetadataModel(effectiveDocument, references);
    if (generation === this.lifecycleGeneration) {
      this.store.registerAlias(docId, model.metadata.docId);
      this.store.writeModel(model, "documentMetadata");
      const canonicalId = this.store.canonicalIdForRoute(docId);
      if (canonicalId) this.pendingMetadata.delete(canonicalId);
      this.pendingMetadata.delete(model.metadata.docId);
    }
    return model;
  }

  private pendingMetadataForRoute(docId: string) {
    const canonicalId = this.store.canonicalIdForRoute(docId);
    return canonicalId ? this.pendingMetadata.get(canonicalId) : undefined;
  }

  private rememberPendingMetadata(docId: string, metadata: DocumentMetadata) {
    const pending = this.pendingMetadata.get(docId);
    if (
      pending?.projectionVersion === metadata.projectionVersion &&
      pending.metadataRevision > metadata.metadataRevision
    ) {
      return;
    }
    this.pendingMetadata.set(docId, metadata);
  }

  private async hydrateReferenceData() {
    if (this.referenceData) return this.referenceData;
    if (this.referenceHydration) return this.referenceHydration;

    const server = this.limitedGraphqlService();
    const generation = this.lifecycleGeneration;
    const hydration = loadDocumentMetadataReferenceData(
      server,
      this.workspaceService.workspace.id,
    )
      .then((references) => {
        if (generation === this.lifecycleGeneration) {
          this.referenceData = references;
        }
        return references;
      })
      .finally(() => {
        if (this.referenceHydration === hydration) {
          this.referenceHydration = null;
        }
      });
    this.referenceHydration = hydration;
    return hydration;
  }

  watchIndexRows() {
    return this.store.watchIndexRows(this.workspaceService.workspace.id);
  }

  watchIndexState() {
    return this.store.watchIndexState(this.workspaceService.workspace.id);
  }

  getIndexState() {
    return this.store.getIndexState(this.workspaceService.workspace.id);
  }

  getIndexRows() {
    return this.store.getIndexRows(this.workspaceService.workspace.id);
  }

  getIndexRowByCanonicalId(docId: string) {
    return this.store.getIndexRowByCanonicalId(
      this.workspaceService.workspace.id,
      docId,
    );
  }

  getIndexRowByExternalId(externalId: string) {
    return this.store.getIndexRowByExternalId(
      this.workspaceService.workspace.id,
      externalId,
    );
  }

  watchIndexLookups() {
    return this.store.watchIndexLookups(this.workspaceService.workspace.id);
  }

  getIndexLookups() {
    return this.store.getIndexLookups(this.workspaceService.workspace.id);
  }

  /**
   * Obsolete the current generation without discarding confirmed rows. When
   * the index has demand, the in-flight request is followed by one coalesced
   * replacement; its late result cannot become current.
   */
  invalidateIndex(reason = "explicit") {
    const previousState = this.getIndexState();
    this.indexGeneration += 1;
    this.indexHydrated = false;
    const workspaceId = this.workspaceService.workspace.id;
    const rows = this.getIndexRows();
    this.store.writeIndexState(workspaceId, {
      phase: rows.length > 0 ? "refreshing" : "unloaded",
      rows,
      error: null,
      generation: this.indexGeneration,
    });
    logger.debug("Index cache invalidated", {
      workspaceId,
      generation: this.indexGeneration,
      reason,
    });
    if (this.indexHydration || previousState.phase !== "unloaded") {
      void this.hydrateIndex().catch((error: unknown) => {
        logger.error("Index cache refresh failed", error);
      });
    }
  }

  async hydrateIndex(): Promise<DocumentMetadataIndexRow[]> {
    this.assertServerBackedWorkspace();
    if (this.indexHydrated) return this.getIndexRows();
    if (this.indexHydration) {
      const activeGeneration = this.indexHydrationGeneration;
      return this.indexHydration.then(
        () =>
          activeGeneration === this.indexGeneration && this.indexHydrated
            ? this.getIndexRows()
            : this.hydrateIndex(),
        (error) =>
          activeGeneration === this.indexGeneration
            ? Promise.reject(error)
            : this.hydrateIndex(),
      );
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const indexGeneration = this.indexGeneration;
    const workspaceId = this.workspaceService.workspace.id;
    const retainedRows = this.getIndexRows();
    this.store.writeIndexState(workspaceId, {
      phase: retainedRows.length > 0 ? "refreshing" : "loading",
      rows: retainedRows,
      error: null,
      generation: indexGeneration,
    });
    const hydration = this.hydrateIndexOnce(
      lifecycleGeneration,
      indexGeneration,
    ).finally(() => {
      if (this.indexHydration === hydration) {
        this.indexHydration = null;
        this.indexHydrationGeneration = null;
      }
    });
    this.indexHydration = hydration;
    this.indexHydrationGeneration = indexGeneration;
    return hydration;
  }

  private async hydrateIndexOnce(
    lifecycleGeneration: number,
    indexGeneration: number,
  ) {
    const workspaceId = this.workspaceService.workspace.id;
    const server = this.limitedGraphqlService();
    const tagRevision = this.tagStore.inventoryRevision;
    try {
      const response = (await server.gql({
        query: documentMetadataIndexQuery,
        variables: { workspaceId, tagWorkspaceId: workspaceId },
      } as never)) as DocumentMetadataIndexQuery;
      if (
        lifecycleGeneration === this.lifecycleGeneration &&
        indexGeneration === this.indexGeneration
      ) {
        this.tagStore.primeInventory(response, tagRevision);
        this.guardService.primeIndexedDocPermissions(
          response.documentMetadataIndex,
        );
        this.store.writeIndexRows(workspaceId, response.documentMetadataIndex);
        this.store.writeIndexState(workspaceId, {
          phase: "ready",
          rows: response.documentMetadataIndex,
          error: null,
          generation: indexGeneration,
        });
        this.indexHydrated = true;
        logger.debug("Index cache hydrated", {
          workspaceId,
          rows: response.documentMetadataIndex.length,
        });
      }
      return response.documentMetadataIndex;
    } catch (error) {
      if (
        lifecycleGeneration === this.lifecycleGeneration &&
        indexGeneration === this.indexGeneration
      ) {
        const rows = this.getIndexRows();
        this.store.writeIndexState(workspaceId, {
          phase: "error",
          rows,
          error,
          generation: indexGeneration,
        });
      }
      throw error;
    }
  }

  async hydrateIndexLookups() {
    this.assertServerBackedWorkspace();
    if (this.lookupsHydrated) return this.getIndexLookups();
    if (this.lookupHydration) return this.lookupHydration;
    const generation = this.lifecycleGeneration;
    const hydration = this.hydrateIndexLookupsOnce(generation).finally(() => {
      if (this.lookupHydration === hydration) {
        this.lookupHydration = null;
      }
    });
    this.lookupHydration = hydration;
    return hydration;
  }

  private async hydrateIndexLookupsOnce(generation: number) {
    const workspaceId = this.workspaceService.workspace.id;
    const server = this.limitedGraphqlService();
    const [types, settings, schemas, classifications] = await Promise.all([
      server.gql({
        query: documentTypesQuery,
      } as never) as Promise<DocumentTypesQuery>,
      server.gql({
        query: workspaceDocumentSettingsQuery,
        variables: { workspaceId },
      } as never) as Promise<WorkspaceDocumentSettingsQuery>,
      server.gql({
        query: documentStatusSchemasQuery,
      } as never) as Promise<DocumentStatusSchemasQuery>,
      server.gql({
        query: documentMetadataValueDefinitionsQuery,
        variables: { fieldKey: "classification" },
      } as never) as Promise<DocumentMetadataValueDefinitionsQuery>,
    ]);
    const schemaId = settings.workspaceDocumentSettings?.statusSchemaId;
    const schemaKey = schemaId
      ? schemas.documentStatusSchemas.find((schema) => schema.id === schemaId)
          ?.key
      : null;
    const statuses = schemaKey
      ? (
          (await server.gql({
            query: documentStatusValuesQuery,
            variables: { schemaKey },
          } as never)) as DocumentStatusValuesQuery
        ).documentStatusValues
      : [];

    const now = new Date().toISOString();
    const lookups = mergeLookups(this.store.getIndexLookups(workspaceId), {
      statusLabels: labelsById(statuses.filter((value) => value.isActive)),
      documentTypeLabels: labelsById(
        types.documentTypes.filter((value) => value.isActive),
      ),
      classificationLabels: labelsById(
        classifications.documentMetadataValueDefinitions.filter(
          (value) => value.isActive,
        ),
      ),
      hydratedKeys: {
        status: true,
        documentType: true,
        classification: true,
      },
      hydratedAt: now,
    });
    if (generation === this.lifecycleGeneration) {
      this.store.writeIndexLookups(workspaceId, lookups);
      this.lookupsHydrated = true;
      logger.debug("Index lookups hydrated", {
        workspaceId,
        statusLabels: Object.keys(lookups.statusLabels).length,
        documentTypeLabels: Object.keys(lookups.documentTypeLabels).length,
        classificationLabels: Object.keys(lookups.classificationLabels).length,
      });
    }
    return lookups;
  }

  clearWorkspace(workspaceId = this.workspaceService.workspace.id) {
    this.lifecycleGeneration += 1;
    const cleared = new Error("Document metadata workspace lifecycle cleared");
    for (const waiter of this.requestWaiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(cleared);
    }
    this.modelHydrations.clear();
    this.pendingMetadata.clear();
    this.referenceData = null;
    this.referenceHydration = null;
    this.indexHydration = null;
    this.indexHydrationGeneration = null;
    this.lookupHydration = null;
    this.indexHydrated = false;
    this.indexGeneration = 0;
    this.lookupsHydrated = false;
    this.store.clearWorkspace(workspaceId);
  }

  override dispose() {
    this.lifecycleSubscription.unsubscribe();
    for (const dispose of this.revalidationDisposers) dispose();
    this.clearWorkspace();
    super.dispose();
  }

  private assertServerBackedWorkspace() {
    if (this.workspaceService.workspace.flavour === "local") {
      throw new Error(
        "Native document metadata is unavailable in local workspaces",
      );
    }
  }

  private limitedGraphqlService(
    signal?: AbortSignal,
  ): Pick<GraphQLService, "gql"> {
    const server = this.workspaceServerService.server;
    if (!server) {
      throw new Error(
        "Cannot hydrate document metadata without a bound workspace server",
      );
    }
    return {
      gql: ((options: unknown) =>
        this.withRequestSlot(
          () => server.gql(options as never),
          signal,
        )) as unknown as GraphQLService["gql"],
    };
  }

  private async withRequestSlot<T>(
    request: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.activeRequests >= 8) {
      await this.waitForRequestSlot(signal);
    }
    signal?.throwIfAborted();
    this.activeRequests += 1;
    try {
      return await request();
    } finally {
      this.activeRequests -= 1;
      const waiter = this.requestWaiters.shift();
      waiter?.cleanup();
      waiter?.resolve();
    }
  }

  private waitForRequestSlot(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.requestWaiters.indexOf(waiter);
        if (index >= 0) this.requestWaiters.splice(index, 1);
        cleanup();
        reject(signal?.reason ?? new Error("Document request aborted"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const waiter = { resolve, reject, cleanup };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.requestWaiters.push(waiter);
    });
  }

  private assertDocumentAvailable(docId: string) {
    this.documentLifecycle.signal(docId).throwIfAborted();
  }
}
