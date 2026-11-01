import { DebugLogger } from "@myoxus/debug";
import {
  documentMetadataQuery,
  workspaceTemplateValuesQuery,
  type SetDocumentMetadataInput,
} from "@myoxus/graphql";
import { Store, yjsGetPath, yjsObserve, yjsObservePath } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";
import type { DocMeta } from "@virgultum/editor/store";
import { nanoid } from "nanoid";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  filter,
  first,
  firstValueFrom,
  fromEvent,
  map,
  of,
  type Subscription,
  switchMap,
  tap,
  takeUntil,
} from "rxjs";
import {
  Array as YArray,
  Map as YMap,
  Doc as YDoc,
  applyUpdate,
  encodeStateVector,
  transact,
  encodeStateAsUpdate,
} from "yjs";

import type { DocProperties } from "../../db/schema/schema";
import { effectiveDocumentTitle } from "../../../editor/virgultum/doc-editor/document-title-sync";
import { setDocumentMetadata } from "../../document-metadata/api";
import {
  observeConfirmedDocumentMetadataIndex,
  type DocumentMetadataCacheService,
  type DocumentMetadataIndexRow,
} from "../../document-metadata/services/document-metadata-cache";
import type { WorkspaceServerService } from "../../server/services/workspace-server";
import type { WorkspaceService } from "../../workspace";
import type { WorkspaceMetaImpl } from "../../workspace/impls/meta";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "../../template-doc/services/template-instantiation-error";
import { isDocumentNotFoundError } from "../errors";
import type { DocPropertiesStore } from "./doc-properties";
import type { DocumentLifecycleStore } from "./document-lifecycle";
import type { TemplateSourceClassification } from "../../template-doc/services/source-metadata";

const NATIVE_METADATA_PROPERTY_KEYS = [
  "createdBy",
  "updatedBy",
  "journal",
  "isTemplate",
  "primaryMode",
  "pageWidth",
  "edgelessColorTheme",
  "integrationType",
] as const;

const logger = new DebugLogger("DocsStore");

export type NativeMetadataPropertyKey =
  (typeof NATIVE_METADATA_PROPERTY_KEYS)[number];

const NATIVE_METADATA_PROPERTY_KEY_SET = new Set<string>(
  NATIVE_METADATA_PROPERTY_KEYS,
);

export function isNativeMetadataPropertyKey(
  key: string,
): key is NativeMetadataPropertyKey {
  return NATIVE_METADATA_PROPERTY_KEY_SET.has(key);
}

function nativeMetadataPropertyValue(
  model: ReturnType<DocumentMetadataCacheService["getModel"]>,
  key: NativeMetadataPropertyKey,
): string | undefined {
  const metadata = model?.metadata;
  if (!metadata) return undefined;
  switch (key) {
    case "createdBy":
      return metadata.system.createdBy ?? undefined;
    case "updatedBy":
      return metadata.system.updatedBy ?? undefined;
    case "journal":
      return metadata.journal.journalDate ?? undefined;
    case "isTemplate":
      return metadata.template?.state && metadata.template.state !== "none"
        ? "true"
        : undefined;
    case "primaryMode":
      return metadata.presentation?.primaryMode ?? undefined;
    case "pageWidth":
      return metadata.presentation?.pageWidth ?? undefined;
    case "edgelessColorTheme":
      return metadata.presentation?.edgelessColorTheme ?? undefined;
    case "integrationType":
      return metadata.integration?.integrationType ?? undefined;
  }
}

function nativeMetadataIndexValue(
  row: DocumentMetadataIndexRow | undefined,
  key: NativeMetadataPropertyKey,
): string | undefined {
  if (!row) return undefined;
  switch (key) {
    case "createdBy":
      return row.createdBy ?? undefined;
    case "updatedBy":
      return row.updatedBy ?? undefined;
    case "journal":
      return typeof row.journalDate === "string" ? row.journalDate : undefined;
    case "isTemplate":
      return row.isTemplate ? "true" : undefined;
    case "primaryMode":
      return row.primaryMode ?? undefined;
    case "pageWidth":
      return row.pageWidth ?? undefined;
    case "edgelessColorTheme":
      return row.edgelessColorTheme ?? undefined;
    case "integrationType":
      return row.integrationType ?? undefined;
  }
}

function hasOwn<T extends object>(target: T, key: keyof T) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

export class DocsStore extends Store {
  private readonly abort = new AbortController();
  private readonly pendingServerCreateIds = new Set<string>();
  private readonly pendingServerCreates = new Map<
    string,
    { dispose: () => void; initialLeafAck: Promise<void> }
  >();
  private membershipSubscription?: Subscription;
  private readonly remoteMembershipSubscriptions = new Map<
    string,
    Subscription
  >();
  private knownMembership: Set<string> | null = null;
  private readonly titleIntentGenerations = new Map<string, number>();
  private readonly titlePreviews = new BehaviorSubject<
    ReadonlyMap<string, { title: string; generation: number }>
  >(new Map());

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly docPropertiesStore: DocPropertiesStore,
    private readonly documentMetadataCache: DocumentMetadataCacheService,
    private readonly documentLifecycle: DocumentLifecycleStore,
  ) {
    super();
    if (
      this.workspaceService.workspace.flavour !== "local" &&
      this.workspaceService.workspace.rootYDoc
    ) {
      this.membershipSubscription = this.watchDocIds().subscribe((docIds) => {
        const next = new Set(docIds);
        let membershipChanged = false;
        if (this.knownMembership) {
          for (const docId of next) {
            if (
              !this.knownMembership.has(docId) &&
              !this.pendingServerCreateIds.has(docId)
            ) {
              this.confirmRemoteMembership(docId);
            }
          }
          for (const docId of this.knownMembership) {
            if (!next.has(docId)) {
              membershipChanged = true;
              this.remoteMembershipSubscriptions.get(docId)?.unsubscribe();
              this.remoteMembershipSubscriptions.delete(docId);
              // Remote membership loss ends the same request generation as a
              // direct permanent delete, including retained comment consumers.
              this.documentLifecycle.markNotFound(docId);
              this.clearDocTitleIntent(docId);
            }
          }
        }
        this.knownMembership = next;
        if (membershipChanged) {
          this.documentMetadataCache.invalidateIndex("root-membership");
        }
      });
    }
  }

  override dispose(): void {
    this.abort.abort();
    for (const pending of this.pendingServerCreates.values()) {
      pending.dispose();
    }
    this.pendingServerCreateIds.clear();
    this.pendingServerCreates.clear();
    for (const subscription of this.remoteMembershipSubscriptions.values()) {
      subscription.unsubscribe();
    }
    this.remoteMembershipSubscriptions.clear();
    this.membershipSubscription?.unsubscribe();
    this.knownMembership = null;
    this.titleIntentGenerations.clear();
    this.titlePreviews.complete();
    super.dispose();
  }

  beginDocTitleIntent(id: string, title: string) {
    const generation = (this.titleIntentGenerations.get(id) ?? 0) + 1;
    this.titleIntentGenerations.set(id, generation);
    if (this.workspaceService.workspace.flavour !== "local") {
      const previews = new Map(this.titlePreviews.value);
      previews.set(id, { title, generation });
      this.titlePreviews.next(previews);
    }
    return generation;
  }

  isCurrentDocTitleIntent(id: string, generation: number) {
    return this.titleIntentGenerations.get(id) === generation;
  }

  failDocTitleIntent(id: string, generation: number) {
    if (!this.isCurrentDocTitleIntent(id, generation)) return;
    this.clearDocTitleIntent(id);
  }

  isServerBackedWorkspace() {
    return this.workspaceService.workspace.flavour !== "local";
  }

  private clearDocTitleIntent(id: string) {
    this.titleIntentGenerations.delete(id);
    if (!this.titlePreviews.value.has(id)) return;
    const previews = new Map(this.titlePreviews.value);
    previews.delete(id);
    this.titlePreviews.next(previews);
  }

  private reconcileDocTitleProjection(id: string, projectedTitle: unknown) {
    const preview = this.titlePreviews.value.get(id);
    if (!preview || projectedTitle !== preview.title) return;
    queueMicrotask(() => {
      if (this.abort.signal.aborted) return;
      const current = this.titlePreviews.value.get(id);
      if (!current || current.generation !== preview.generation) return;
      const previews = new Map(this.titlePreviews.value);
      previews.delete(id);
      this.titlePreviews.next(previews);
    });
  }

  private rawDocMeta$(id: string) {
    return (
      this.workspaceService.workspace.docCollection.meta as WorkspaceMetaImpl
    )
      .watchDocMeta(id)
      .pipe(tap((meta) => this.reconcileDocTitleProjection(id, meta.title)));
  }

  getVirgultumDoc(
    id: string,
    options: { readonly?: boolean; id?: string } = {},
  ) {
    return (
      this.workspaceService.workspace.docCollection
        .getDoc(id)
        ?.getStore({ id, ...options }) ?? null
    );
  }

  getVirgultumCollection() {
    return this.workspaceService.workspace.docCollection;
  }

  createDoc(docId?: string, title = "") {
    const id = docId ?? nanoid();
    const docs = this.workspaceService.workspace.rootYDoc
      .getMap("meta")
      .get("pages");
    if (!(docs instanceof YArray)) {
      return id;
    }

    const serverBacked = this.workspaceService.workspace.flavour !== "local";
    const creationIntent = nanoid();
    if (serverBacked) {
      // Root Yjs observers run synchronously inside the transaction below. Lock
      // the ID first so the membership observer cannot mistake local create
      // intent for confirmation that the server has materialized the leaf.
      this.pendingServerCreateIds.add(id);
      this.documentLifecycle.beginCreating(id);
    }

    transact(
      this.workspaceService.workspace.rootYDoc,
      () => {
        const meta = new YMap<unknown>([
          ["id", id],
          ["title", title],
          ["createDate", Date.now()],
          ["creationIntent", creationIntent],
        ]);
        // Remote labels are confirmed through SQL reads, never a live Yjs
        // field. Local-only native workspaces retain their local array.
        if (!serverBacked) meta.set("tags", new YArray());
        docs.push([meta]);
      },
      { force: true },
    );

    // This write is owned by actual creation, including Native offline pages.
    // It survives cache reopen in the existing Yjs stream; a peer never invents it.
    const leaf = this.getVirgultumDoc(id)?.spaceDoc;
    leaf?.transact(() => {
      const meta = leaf.getMap("meta");
      meta.set("pageCreationId", id);
      meta.set("pageCreationIntent", creationIntent);
    });
    if (serverBacked) {
      const pending = this.watchInitialLeafUpdate(id);
      this.pendingServerCreates.set(id, pending);
      void this.confirmServerBackedCreate(id);
    } else {
      this.documentLifecycle.beginAvailableLifecycle(id, "created");
    }

    return id;
  }

  watchDocIds() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap("meta"),
      "pages",
    ).pipe(
      switchMap(yjsObserve),
      map((meta) => {
        if (meta instanceof YArray) {
          return meta.map((v) => v.get("id") as string);
        } else {
          return [];
        }
      }),
    );
  }

  /** Explicit user recovery is creation authority; cache observation is not. */
  async recoverDocRegistration(id: string) {
    const workspace = this.workspaceService.workspace;
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(30_000),
    ]);
    const record = await workspace.engine.doc.storage.getDoc(id);
    if (!record || workspace.flavour === "local") {
      throw new Error(
        "No server-backed local document is available for recovery",
      );
    }
    const leaf = new YDoc();
    let update: Uint8Array;
    try {
      applyUpdate(leaf, record.bin);
      const before = encodeStateVector(leaf);
      leaf.transact(() => {
        const meta = leaf.getMap("meta");
        const intent = meta.get("pageCreationIntent");
        if (
          meta.get("pageCreationId") !== id ||
          typeof intent !== "string" ||
          !intent
        ) {
          meta.set("pageCreationId", id);
          meta.set("pageCreationIntent", nanoid());
        }
      });
      update = encodeStateAsUpdate(leaf, before);
    } finally {
      leaf.destroy();
    }
    this.documentLifecycle.beginCreating(id);
    await workspace.engine.doc.saveDetachedUpdateAndWaitForSynced(
      id,
      update,
      signal,
    );
    await firstValueFrom(
      workspace.engine.doc.docState$(id).pipe(
        filter(
          (state) => state.synced && state.pageRegistration === "registered",
        ),
        takeUntil(fromEvent(signal, "abort")),
        first(),
      ),
    );
    await firstValueFrom(
      this.watchDocIds().pipe(
        filter((ids) => ids.includes(id)),
        takeUntil(fromEvent(signal, "abort")),
        first(),
      ),
    );
    this.documentLifecycle.beginAvailableLifecycle(id, "created");
  }

  watchAllDocUpdatedDate() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap("meta"),
      "pages",
    ).pipe(
      switchMap((pages) => yjsObservePath(pages, "*.updatedDate")),
      map((pages) => {
        if (pages instanceof YArray) {
          return pages.map((v) => ({
            id: v.get("id") as string,
            updatedDate: v.get("updatedDate") as number | undefined,
          }));
        } else {
          return [];
        }
      }),
    );
  }

  watchAllDocCreateDate() {
    return yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap("meta"),
      "pages",
    ).pipe(
      switchMap((pages) => yjsObservePath(pages, "*.createDate")),
      map((pages) => {
        if (pages instanceof YArray) {
          return pages.map((v) => ({
            id: v.get("id") as string,
            createDate: (v.get("createDate") ?? 0) as number,
          }));
        } else {
          return [];
        }
      }),
    );
  }

  watchAllDocTitle() {
    const projected = yjsGetPath(
      this.workspaceService.workspace.rootYDoc.getMap("meta"),
      "pages",
    ).pipe(
      switchMap((pages) => yjsObservePath(pages, "*.title")),
      map((pages) => {
        if (pages instanceof YArray) {
          return pages.map((v) => ({
            id: v.get("id") as string,
            title: (v.get("title") ?? "") as string,
          }));
        } else {
          return [];
        }
      }),
      tap((entries) => {
        for (const entry of entries) {
          this.reconcileDocTitleProjection(entry.id, entry.title);
        }
      }),
    );
    return combineLatest([projected, this.titlePreviews]).pipe(
      map(([entries, previews]) =>
        entries.map((entry) => ({
          ...entry,
          title: effectiveDocumentTitle(
            entry.title,
            previews.get(entry.id)?.title,
          ),
        })),
      ),
    );
  }

  watchNonTrashDocIds() {
    const rootMeta = this.workspaceService.workspace.rootYDoc.getMap("meta");
    return yjsObservePath(rootMeta, "pages.*.trash").pipe(
      map((meta) => {
        const pages = meta instanceof YMap ? meta.get("pages") : null;
        if (pages instanceof YArray) {
          return pages
            .map((v) => (v.get("trash") ? null : v.get("id")))
            .filter(Boolean) as string[];
        } else {
          return [];
        }
      }),
    );
  }

  watchTrashDocIds() {
    const rootMeta = this.workspaceService.workspace.rootYDoc.getMap("meta");
    return yjsObservePath(rootMeta, "pages.*.trash").pipe(
      map((meta) => {
        const pages = meta instanceof YMap ? meta.get("pages") : null;
        if (pages instanceof YArray) {
          return pages
            .map((v) => (v.get("trash") ? v.get("id") : null))
            .filter(Boolean) as string[];
        } else {
          return [];
        }
      }),
    );
  }

  watchDocMeta(id: string) {
    return combineLatest([this.rawDocMeta$(id), this.titlePreviews]).pipe(
      map(([meta, previews]) => {
        const preview = previews.get(id);
        return preview
          ? {
              ...meta,
              title: effectiveDocumentTitle(meta.title, preview.title),
            }
          : meta;
      }),
    );
  }

  watchDocListReady() {
    return this.workspaceService.workspace.engine.doc
      .docState$(this.workspaceService.workspace.id)
      .pipe(map((state) => state.synced));
  }

  getDocMetaSnapshot(id: string): Partial<DocMeta> {
    return (
      this.workspaceService.workspace.docCollection.meta as WorkspaceMetaImpl
    ).getDocMetaSnapshot(id);
  }

  /** Wait for the existing sync owner; checking must never save a detached update. */
  async waitForTemplateSourceSynced(id: string, signal: AbortSignal) {
    if (!this.templateWorkspaceContext.serverBacked) return;
    await this.workspaceService.workspace.engine.doc.waitForSynced(id, signal);
  }

  /** Persist the complete leaf through its storage owner, including offline
   * imports made before the native editor connects this Y.Doc. */
  async waitForDocSynced(id: string, signal?: AbortSignal) {
    const docSync = this.workspaceService.workspace.engine?.doc;
    if (!docSync?.waitForSynced) {
      return;
    }
    const leaf = this.getVirgultumDoc(id)?.spaceDoc;
    if (!leaf) throw new Error("Cannot persist an unloaded document");
    await docSync.saveDetachedUpdateAndWaitForSynced(
      id,
      encodeStateAsUpdate(leaf),
      signal,
    );
  }

  setDocMeta(id: string, meta: Partial<DocMeta>) {
    const rootYDoc = this.workspaceService.workspace.rootYDoc;
    const pages = rootYDoc?.getMap("meta").get("pages");

    if (!(pages instanceof YArray)) {
      this.workspaceService.workspace.docCollection.meta.setDocMeta(id, meta);
      return;
    }

    transact(
      rootYDoc,
      () => {
        for (const doc of pages) {
          if (!(doc instanceof YMap) || doc.get("id") !== id) {
            continue;
          }
          Object.entries(meta).forEach(([key, value]) => {
            if (value === undefined) {
              doc.delete(key);
            } else {
              doc.set(key, value);
            }
          });
          return;
        }
      },
      { force: true },
    );
  }

  setManyDocMeta(updates: Array<{ id: string; meta: Partial<DocMeta> }>) {
    if (updates.length === 0) {
      return;
    }

    const rootYDoc = this.workspaceService.workspace.rootYDoc;
    const pages = rootYDoc?.getMap("meta").get("pages");

    if (!(pages instanceof YArray)) {
      for (const { id, meta } of updates) {
        this.workspaceService.workspace.docCollection.meta.setDocMeta(id, meta);
      }
      return;
    }

    const updateById = new Map(
      updates.map(({ id, meta }) => [id, meta] as const),
    );

    // List-level actions such as selected drag-to-trash need one root-meta
    // transaction. Under sync pressure, a sequence of per-document transactions
    // can be replayed partially and keep confirmation flows pending on stale
    // All Docs projections.
    transact(
      rootYDoc,
      () => {
        for (const doc of pages) {
          if (!(doc instanceof YMap)) {
            continue;
          }
          const meta = updateById.get(doc.get("id") as string);
          if (!meta) {
            continue;
          }
          Object.entries(meta).forEach(([key, value]) => {
            if (value === undefined) {
              doc.delete(key);
            } else {
              doc.set(key, value);
            }
          });
        }
      },
      { force: true },
    );
  }

  removeManyDocMeta(ids: string[]) {
    const idsToRemove = new Set(ids.filter(Boolean));
    if (idsToRemove.size === 0) {
      return;
    }
    const previews = new Map(this.titlePreviews.value);
    for (const id of idsToRemove) {
      previews.delete(id);
      this.titleIntentGenerations.delete(id);
    }
    this.titlePreviews.next(previews);

    if (this.workspaceService.workspace.flavour !== "local") {
      for (const id of idsToRemove) {
        this.documentLifecycle.markNotFound(id);
      }
    }

    const rootYDoc = this.workspaceService.workspace.rootYDoc;
    const pages = rootYDoc?.getMap("meta").get("pages");

    if (!(pages instanceof YArray)) {
      for (const id of idsToRemove) {
        this.workspaceService.workspace.docCollection.meta.removeDocMeta(id);
      }
      return;
    }

    // Permanent-delete server mutations are authoritative, but the visible
    // trash/all-docs lists observe the local root metadata. Remove every
    // acknowledged entry in one root-meta transaction so the projections update
    // immediately without waiting for document-content deletion or cloud sync.
    transact(
      rootYDoc,
      () => {
        for (let index = pages.length - 1; index >= 0; index -= 1) {
          const doc = pages.get(index);
          if (doc instanceof YMap && idsToRemove.has(doc.get("id") as string)) {
            pages.delete(index, 1);
          }
        }
      },
      { force: true },
    );
  }

  setDocPrimaryModeSetting(id: string, mode: DocMode) {
    return this.setNativeSubsystemMetadata(id, { primaryMode: mode });
  }

  setDocJournalDateSetting(id: string, date: string | null) {
    return this.setNativeSubsystemMetadata(id, { journalDate: date });
  }

  setDocTemplateStateSetting(
    id: string,
    isTemplate: boolean,
    signal?: AbortSignal,
    origin?: "custom",
    classification?: TemplateSourceClassification,
  ) {
    return this.setNativeSubsystemMetadata(
      id,
      {
        templateState: isTemplate ? "managed" : null,
        ...(isTemplate && origin ? { templateOrigin: origin } : {}),
        ...(isTemplate && classification
          ? {
              templateCategory: classification.category,
              templateTags: [...classification.tags],
            }
          : {}),
      },
      signal,
    );
  }

  setDocPageWidthSetting(id: string, pageWidth: string | null) {
    return this.setNativeSubsystemMetadata(id, { pageWidth });
  }

  setDocTemplateClassification(
    id: string,
    category: string | null,
    tags: string[] | null,
  ) {
    return this.setNativeSubsystemMetadata(id, {
      templateCategory: category,
      templateTags: tags,
    });
  }

  async readDocTemplateClassification(id: string, signal?: AbortSignal) {
    if (this.workspaceService.workspace.flavour === "local") {
      const properties = this.docPropertiesStore.getDocProperties(id);
      return {
        category: properties.templateCategory || null,
        tags: properties.templateTags ?? null,
      };
    }
    // Classification is metadata-only: remote membership may precede loading
    // the source leaf. The route cache's lifecycle gate requires that leaf.
    const server = this.workspaceServerService.server;
    if (!server) throw new Error("Template metadata server is unavailable");
    const response = await server.gql({
      query: documentMetadataQuery,
      variables: { workspaceId: this.workspaceService.workspace.id, docId: id },
      context: {
        signal: signal
          ? AbortSignal.any([this.abort.signal, signal])
          : this.abort.signal,
      },
    });
    const metadata = response.documentMetadata;
    return {
      category: metadata.template?.category ?? null,
      tags: metadata.template?.tags ?? null,
    };
  }

  watchDocTemplateClassification(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => ({
        category: properties.templateCategory || null,
        tags: properties.templateTags ?? null,
      }),
      (model) => ({
        category: model?.metadata.template?.category ?? null,
        tags: model?.metadata.template?.tags ?? null,
      }),
      (row) => ({
        category: row?.templateCategory ?? null,
        tags: row?.templateTags ?? null,
      }),
    );
  }

  setDocEdgelessColorThemeSetting(
    id: string,
    edgelessColorTheme: string | null,
  ) {
    return this.setNativeSubsystemMetadata(id, { edgelessColorTheme });
  }

  setDocIntegrationTypeSetting(id: string, integrationType: string | null) {
    return this.setNativeSubsystemMetadata(id, { integrationType });
  }

  getDocPrimaryModeSetting(id: string) {
    if (this.workspaceService.workspace.flavour === "local") {
      return this.docPropertiesStore.getDocProperties(id)?.primaryMode;
    }
    const acknowledgedWrite =
      this.documentMetadataCache.getListModelOverride(id);
    if (acknowledgedWrite) {
      return acknowledgedWrite.metadata.presentation?.primaryMode ?? undefined;
    }
    const indexState = this.documentMetadataCache.getIndexState();
    const hasConfirmedIndex =
      indexState.rows.length > 0 ||
      indexState.phase === "ready" ||
      indexState.phase === "refreshing";
    if (hasConfirmedIndex) {
      return (
        this.documentMetadataCache.getIndexRowByExternalId(id)?.primaryMode ??
        undefined
      );
    }
    return (
      this.documentMetadataCache.getModel(id)?.metadata.presentation
        ?.primaryMode ?? undefined
    );
  }

  watchDocPrimaryModeSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties.primaryMode,
      (model) => model?.metadata.presentation?.primaryMode ?? undefined,
      (row) => row?.primaryMode ?? undefined,
    );
  }

  watchDocCreatedBySetting(id: string) {
    return this.watchDocSystemFactSetting(id, "createdBy");
  }

  watchDocUpdatedBySetting(id: string) {
    return this.watchDocSystemFactSetting(id, "updatedBy");
  }

  watchDocJournalDateSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties.journal,
      (model) => model?.metadata.journal.journalDate ?? undefined,
      (row) =>
        typeof row?.journalDate === "string" ? row.journalDate : undefined,
    );
  }

  watchDocTemplateStateSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties.isTemplate,
      (model) => {
        const state = model?.metadata.template?.state;
        return state != null && state !== "none";
      },
      (row) => row?.isTemplate ?? false,
    );
  }

  watchDocTemplateAttributionSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      () => undefined,
      (model) => model?.metadata.template ?? undefined,
    );
  }

  watchDocPageWidthSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties.pageWidth,
      (model) => model?.metadata.presentation?.pageWidth ?? undefined,
      (row) => row?.pageWidth ?? undefined,
    );
  }

  watchDocEdgelessColorThemeSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties.edgelessColorTheme,
      (model) => model?.metadata.presentation?.edgelessColorTheme ?? undefined,
      (row) => row?.edgelessColorTheme ?? undefined,
    );
  }

  watchDocIntegrationTypeSetting(id: string) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties.integrationType,
      (model) =>
        (model?.metadata.integration?.integrationType ??
          undefined) as DocProperties["integrationType"],
      (row) =>
        (row?.integrationType ?? undefined) as DocProperties["integrationType"],
    );
  }

  watchNativeMetadataPropertyValues(key: NativeMetadataPropertyKey) {
    if (this.workspaceService.workspace.flavour === "local") {
      return combineLatest([
        this.watchDocIds(),
        this.docPropertiesStore.watchPropertyAllValues(key),
      ]).pipe(
        map(
          ([docIds, propertyValues]) =>
            new Map(
              docIds.map(
                (docId) => [docId, propertyValues.get(docId)] as const,
              ),
            ),
        ),
      );
    }

    return this.watchDocIds().pipe(
      distinctUntilChanged(
        (previous, current) =>
          previous.length === current.length &&
          previous.every((id, index) => id === current[index]),
      ),
      switchMap((docIds) =>
        combineLatest([
          observeConfirmedDocumentMetadataIndex(this.documentMetadataCache),
          this.documentMetadataCache.watchListModelOverrides(),
        ]).pipe(
          map(
            () =>
              new Map(
                docIds.map((docId) => {
                  const acknowledgedWrite =
                    this.documentMetadataCache.getListModelOverride(docId);
                  return [
                    docId,
                    acknowledgedWrite
                      ? nativeMetadataPropertyValue(acknowledgedWrite, key)
                      : nativeMetadataIndexValue(
                          this.documentMetadataCache.getIndexRowByExternalId(
                            docId,
                          ),
                          key,
                        ),
                  ] as const;
                }),
              ),
          ),
        ),
      ),
    );
  }

  watchTemplateOriginValues() {
    if (this.workspaceService.workspace.flavour === "local") {
      return of(new Map<string, string | undefined>());
    }
    return observeConfirmedDocumentMetadataIndex(
      this.documentMetadataCache,
    ).pipe(
      map((state) => {
        const origins = new Map<string, string | undefined>();
        for (const row of state.rows) {
          const origin = row.templateOrigin ?? undefined;
          origins.set(String(row.docId), origin);
          if (row.externalId) origins.set(String(row.externalId), origin);
        }
        return origins;
      }),
    );
  }

  waitForDocLoadReady(id: string, signal?: AbortSignal) {
    return this.workspaceService.workspace.engine.doc.waitForDocLoaded(
      id,
      signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal,
    );
  }

  get templateWorkspaceContext() {
    const workspace = this.workspaceService.workspace;
    return {
      id: workspace.id,
      name: workspace.name$.value,
      serverBacked: workspace.flavour !== "local",
    };
  }

  /** Requested server template facts; cancellation shares the application deadline. */
  async readTemplateValues(
    requested: readonly string[],
    targetDocId: string | undefined,
    context: { folderId?: string; parentDocId?: string },
    signal: AbortSignal,
    deferCreation = false,
  ): Promise<import("../services/template-repeat").TemplateVariables> {
    const server = this.workspaceServerService.server;
    if (!server || !this.templateWorkspaceContext.serverBacked)
      throw new TemplateInstantiationError("local-only-incompatible");
    const attempt = AbortSignal.any([this.abort.signal, signal]);
    let factSignal = attempt;
    try {
      // A supplied target may be a freshly created leaf. Both its permission
      // preflight and creation facts use the acknowledged lifecycle generation.
      const creationRequested = requested.some(
        (path) =>
          path.startsWith("creator.") ||
          path.startsWith("document.created_at."),
      );
      if (!deferCreation && creationRequested && !targetDocId)
        throw new TemplateInstantiationError("metadata-unavailable");
      if (targetDocId && (deferCreation || creationRequested)) {
        factSignal = await this.documentLifecycle.waitUntilAvailable(
          targetDocId,
          attempt,
        );
      }
      const result = await waitForTemplateOperation(
        server.gql({
          query: workspaceTemplateValuesQuery,
          variables: {
            workspaceId: this.workspaceService.workspace.id,
            requested: [...requested],
            targetDocId,
            ...context,
            deferCreation,
          },
          context: { signal: factSignal },
        }),
        factSignal,
      );
      factSignal.throwIfAborted();
      const values = result.workspace?.templateContext?.requestedValues;
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw new TemplateInstantiationError("metadata-unavailable");
      return values;
    } catch (cause) {
      attempt.throwIfAborted();
      if (cause instanceof TemplateInstantiationError) throw cause;
      const reason = (cause as { extensions?: { templateReason?: unknown } })
        .extensions?.templateReason;
      const supported = [
        "member-fetch",
        "creator-unavailable",
        "metadata-unavailable",
        "empty-field",
        "organization-unavailable",
        "owner-unit-unavailable",
        "parent-unavailable",
        "folder-ambiguous",
        "folder-absent",
        "unresolved-variable",
      ] as const;
      throw new TemplateInstantiationError(
        supported.find((value) => value === reason) ?? "metadata-unavailable",
        { cause },
      );
    }
  }

  watchTemplateSyncFailure(id: string, fail: () => void) {
    return this.workspaceService.workspace.engine.doc
      .docState$(id)
      .subscribe((state) => {
        if (state.syncRetrying) fail();
      });
  }

  addPriorityLoad(id: string, priority: number) {
    return this.workspaceService.workspace.engine.doc.addPriority(id, priority);
  }

  private async setNativeSubsystemMetadata(
    id: string,
    input: SetDocumentMetadataInput,
    signal?: AbortSignal,
  ) {
    if (this.workspaceService.workspace.flavour === "local") {
      await this.applyOfflineSubsystemProjectionFromInput(id, input);
      return;
    }

    // Creation confirmation owns the root/leaf acknowledgement for new docs.
    // Once that lifecycle is available, native metadata is an independent
    // server mutation: waiting on the storage worker a second time can strand
    // the write after the worker has already reported the document as synced.
    const attempt = signal
      ? AbortSignal.any([this.abort.signal, signal])
      : this.abort.signal;
    // Only a locally initiated create needs the root/leaf acknowledgement gate.
    // Remote membership can be visible in the authoritative document/index
    // projections before its leaf is loaded, and metadata-only actions must not
    // wait for that unrelated content hydration.
    const lifecycleState = this.documentLifecycle.state(id);
    const requestSignal = this.pendingServerCreateIds.has(id)
      ? await this.documentLifecycle.waitUntilAvailable(id, attempt)
      : lifecycleState === "available"
        ? this.documentLifecycle.requestSignal(id, attempt)
        : lifecycleState === "not-found"
          ? this.documentLifecycle.requestSignal(id, attempt)
          : attempt;

    try {
      const server = this.workspaceServerService.server;
      if (!server) {
        throw new Error(
          "Cannot persist native document metadata without a bound workspace server",
        );
      }
      const metadata = await setDocumentMetadata(
        server,
        this.workspaceService.workspace.id,
        id,
        input,
        requestSignal,
      );
      // An unloaded catalog source has no available editor model. Its
      // acknowledged metadata belongs in the index until that model is loaded.
      if (this.documentLifecycle.isAvailable(id)) {
        await this.documentMetadataCache.writeMetadataForDocument(
          id,
          metadata,
          "setDocumentMetadata",
        );
      }
      this.documentMetadataCache.invalidateIndex("metadata-write");
      await this.documentMetadataCache.hydrateIndex();
    } catch (error) {
      if (isDocumentNotFoundError(error)) {
        this.documentLifecycle.markNotFound(id);
      }
      console.error("[doc-metadata] native subsystem write failed", {
        docId: id,
        keys: Object.keys(input),
        error,
      });
      throw error;
    }
  }

  async waitForCreateAcknowledgement(
    id: string,
    signal?: AbortSignal,
    canonicalRoot = false,
  ) {
    if (this.workspaceService.workspace.flavour === "local") {
      return;
    }
    const attempt = signal
      ? AbortSignal.any([this.abort.signal, signal])
      : this.abort.signal;
    await this.documentLifecycle.waitUntilAvailable(id, attempt);
    if (!canonicalRoot) return;
    // Worker registration can be acknowledged before its authoritative root
    // fold reaches this frontend Y.Doc. Builder metadata written to a provisional
    // duplicate would then be deleted by that fold. Observe the existing server
    // owner here; do not invent a second registration protocol in a diagram UI.
    const root = this.workspaceService.workspace.rootYDoc;
    await new Promise<void>((resolve, reject) => {
      const dispose = () => {
        root.off("afterTransaction", check);
        attempt.removeEventListener("abort", abort);
      };
      const abort = () => {
        dispose();
        reject(attempt.reason);
      };
      const check = () => {
        const pages = root.getMap("meta").get("pages");
        if (!(pages instanceof YArray)) return;
        const entries = pages
          .toArray()
          .filter(
            (entry) => entry instanceof YMap && entry.get("id") === id,
          ) as YMap<unknown>[];
        if (
          entries.length === 1 &&
          entries[0].get("registrationOwner") === true
        ) {
          dispose();
          resolve();
        }
      };
      root.on("afterTransaction", check);
      attempt.addEventListener("abort", abort, { once: true });
      if (attempt.aborted) abort();
      else check();
    });
  }

  private async confirmServerBackedCreate(id: string) {
    const pending = this.pendingServerCreates.get(id);
    try {
      if (!pending) {
        throw new Error("Cannot confirm an untracked server-backed document");
      }
      // A sync state can be idle before the newly created Virgultum leaf has
      // emitted content. Require that first local leaf update before waiting
      // for storage and remote acknowledgement, otherwise an empty document
      // can be declared available before its materializing push exists.
      await pending.initialLeafAck;
      const docSync = this.workspaceService.workspace.engine?.doc;
      if (!docSync?.waitForSynced) {
        throw new Error(
          "Cannot confirm server-backed document creation without document sync",
        );
      }
      await docSync.waitForSynced(
        this.workspaceService.workspace.id,
        this.abort.signal,
      );
      await firstValueFrom(
        docSync.docState$(id).pipe(
          filter(
            (state) => state.synced && state.pageRegistration === "registered",
          ),
          takeUntil(fromEvent(this.abort.signal, "abort")),
          first(),
        ),
      );
      if (!this.abort.signal.aborted) {
        // Byte durability alone does not certify SQL/leaf/root registration.
        this.documentLifecycle.beginAvailableLifecycle(id, "created");
        this.documentMetadataCache.invalidateIndex("document-created");
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        logger.error("Server-backed document creation did not synchronize", {
          docId: id,
          error,
        });
        this.documentLifecycle.markNotFound(id);
      }
    } finally {
      pending?.dispose();
      if (this.pendingServerCreates.get(id) === pending) {
        this.pendingServerCreates.delete(id);
      }
      this.pendingServerCreateIds.delete(id);
    }
  }

  private confirmRemoteMembership(id: string) {
    this.remoteMembershipSubscriptions.get(id)?.unsubscribe();
    this.documentLifecycle.beginCreating(id);

    // Root metadata and the first leaf push are separate Yjs streams. Another
    // client can therefore observe membership while the server still reports
    // the leaf as missing. Keep API consumers behind the creating generation
    // until storage has pulled a real remote leaf; a route mount or metadata
    // retry is not allowed to revive the ID by itself.
    //
    // `state.ready` must hold alongside `state.synced` and the absence flag.
    // A peer pull can flip `synced` before DocFrontend applies the resulting
    // remote update to the YDoc, and confirming the lifecycle on that idle
    // rootless window would surface a not-found doc as available.
    const subscription = this.workspaceService.workspace.engine.doc
      .docState$(id)
      .pipe(
        filter(
          (state) =>
            state.synced &&
            state.ready &&
            !state.remoteMissing &&
            state.pageRegistration !== "pending" &&
            state.pageRegistration !== "unresolved" &&
            state.pageRegistration !== "deleted",
        ),
        first(),
      )
      .subscribe({
        next: () => {
          if (!this.abort.signal.aborted) {
            this.documentLifecycle.beginAvailableLifecycle(id, "membership");
            this.documentMetadataCache.invalidateIndex("root-membership");
          }
          this.remoteMembershipSubscriptions.delete(id);
        },
      });
    if (!subscription.closed) {
      this.remoteMembershipSubscriptions.set(id, subscription);
    }
  }

  private watchInitialLeafUpdate(id: string) {
    const leaf = this.getVirgultumDoc(id)?.spaceDoc;
    let dispose = () => {};
    const initialLeafAck = new Promise<void>((resolve, reject) => {
      if (!leaf) {
        reject(new Error("Cannot observe the new document leaf"));
        return;
      }
      const onUpdate = () => {
        dispose();
        void this.workspaceService.workspace.engine.doc
          .saveDetachedUpdateAndWaitForSynced(
            id,
            encodeStateAsUpdate(leaf),
            this.abort.signal,
          )
          .then(resolve, reject);
      };
      const onAbort = () => {
        dispose();
        reject(this.abort.signal.reason);
      };
      dispose = () => {
        leaf.off("update", onUpdate);
        this.abort.signal.removeEventListener("abort", onAbort);
      };
      leaf.on("update", onUpdate);
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    return { dispose, initialLeafAck };
  }

  private watchDocSystemFactSetting(
    id: string,
    key: "createdBy" | "updatedBy",
  ) {
    return this.watchDocNativeMetadataSetting(
      id,
      (properties) => properties[key],
      (model) => nativeMetadataPropertyValue(model, key),
      (row) => nativeMetadataIndexValue(row, key),
    );
  }

  private watchDocNativeMetadataSetting<T>(
    id: string,
    localValue: (properties: DocProperties) => T,
    serverValue: (
      model: ReturnType<DocumentMetadataCacheService["getModel"]>,
    ) => T,
    indexValue?: (row: DocumentMetadataIndexRow | undefined) => T,
  ) {
    return (
      this.workspaceService.workspace.flavour === "local"
        ? this.docPropertiesStore.watchDocProperties(id).pipe(map(localValue))
        : indexValue
          ? combineLatest([
              observeConfirmedDocumentMetadataIndex(this.documentMetadataCache),
              this.documentMetadataCache.watchListModelOverrides(),
            ]).pipe(
              map(() => {
                const acknowledgedWrite =
                  this.documentMetadataCache.getListModelOverride(id);
                return acknowledgedWrite
                  ? serverValue(acknowledgedWrite)
                  : indexValue(
                      this.documentMetadataCache.getIndexRowByExternalId(id),
                    );
              }),
            )
          : this.documentMetadataCache.watchModel(id).map(serverValue)
    ).pipe(distinctUntilChanged());
  }

  private applyOfflineSubsystemProjectionFromInput(
    id: string,
    input: SetDocumentMetadataInput,
  ) {
    const projection = this.subsystemProjectionFromInput(input);
    return hasOwn(input, "primaryMode")
      ? this.docPropertiesStore.applyOfflineSubsystemProjection(
          id,
          projection,
          true,
        )
      : this.docPropertiesStore.applyOfflineSubsystemProjection(id, projection);
  }

  private subsystemProjectionFromInput(input: SetDocumentMetadataInput) {
    const projection: Partial<DocProperties> = {};
    if (hasOwn(input, "journalDate")) {
      projection.journal = input.journalDate ?? "";
    }
    if (hasOwn(input, "templateState")) {
      projection.isTemplate = input.templateState != null;
      if (!projection.isTemplate) {
        projection.templateCategory = "";
        projection.templateTags = null;
      }
    }
    if (hasOwn(input, "templateCategory")) {
      projection.templateCategory = input.templateCategory ?? "";
    }
    if (hasOwn(input, "templateTags")) {
      projection.templateTags = input.templateTags ?? null;
    }
    if (hasOwn(input, "primaryMode")) {
      projection.primaryMode = input.primaryMode ?? "page";
    }
    if (hasOwn(input, "pageWidth")) {
      projection.pageWidth = input.pageWidth ?? "";
    }
    if (hasOwn(input, "edgelessColorTheme")) {
      projection.edgelessColorTheme = input.edgelessColorTheme ?? "";
    }
    if (hasOwn(input, "integrationType")) {
      projection.integrationType = (input.integrationType ??
        undefined) as DocProperties["integrationType"];
    }
    return projection as Parameters<
      DocPropertiesStore["applyOfflineSubsystemProjection"]
    >[1];
  }
}
