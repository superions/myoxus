import {
  prepareTemplateValues,
  formatTemplateCreationValues,
  applyNativeTemplateValues,
  type TemplatePreparationOptions,
} from "../../template-doc/services/template-preparation";
import { TagStore } from "../../tag/stores/tag";
import { waitForDocumentVersionSync } from "../../doc-versioning/document-sync";
import { DebugLogger } from "@myoxus/debug";
import { Unreachable } from "@myoxus/env/constant";
import { LiveData, ObjectPool, Service } from "@myoxus/infra";
import { replaceIdMiddleware } from "@virgultum/editor/shared/adapters";
import type { MyoxusTextAttributes } from "@virgultum/editor/shared/types";
import {
  type DeltaInsert,
  Slice,
  Text,
  Transformer,
} from "@virgultum/editor/store";
import { combineLatest, map, type Subscription } from "rxjs";
import { isEqual } from "lodash-es";
import { nanoid } from "nanoid";
import {
  applyUpdate,
  Doc as YDoc,
  Map as YMap,
  encodeStateAsUpdate,
  type Transaction,
} from "yjs";

import { initDocFromProps } from "../../../editor/initialization";
import { getMyoxusWorkspaceSchema } from "../../workspace/global-schema";
import { readNativeTemplateSnapshot } from "../../template-doc/services/native-bundle";
import { captureTemplateSource } from "../../template-doc/services/template-source-capture";
import { TemplateDocService } from "../../template-doc/services/template-doc";
import type {
  TemplateTitlePolicy,
  TemplateSourceClassification,
} from "../../template-doc/services/source-metadata";
import { type RegionalFormatPreferences } from "../../i18n";
import { FolderStore } from "../../organize/stores/folder";
import type { TemplateCreationContext } from "../../template-doc/services/template-instantiation";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "../../template-doc/services/template-instantiation-error";
import {
  inspectTemplateSnapshot,
  MEMBER_REPEAT_SOURCE,
  scalarTemplateVariables,
  validateTemplateRepeats,
  type TemplateVariables,
  type TemplateTextLocation,
} from "./template-repeat";
import type { Doc } from "../entities/doc";
import type { DocRecord } from "../entities/record";
import { DocRecordList } from "../entities/record-list";
import { DocCreated, DocInitialized } from "../events";
import type { DocCreateMiddleware } from "../providers/doc-create-middleware";
import { DocScope } from "../scopes/doc";
import type { DocPropertiesStore } from "../stores/doc-properties";
import { type DocsStore, isNativeMetadataPropertyKey } from "../stores/docs";
import type { DocCreateOptions } from "../types";
import { DocService } from "./doc";
import { getDuplicatedDocTitle } from "./duplicate-title";
import {
  templateVariableCapabilities,
  optionalProjectTemplateVariableNames,
  optionalPreparationTemplateVariableNames,
  type TemplateDateInput,
  replaceTemplateVariables,
  templateVariableRanges,
} from "./template-variables";

export type TemplateCheckDiagnostic = TemplateTextLocation & {
  start: number;
  length: number;
  name?: string;
  status: "available" | "application" | "input" | "context" | "error";
  reason?:
    | import("../../template-doc/services/template-instantiation-error").TemplateInstantiationFailure
    | "unknown-token";
};
export type TemplateCheckResult = Awaited<
  ReturnType<DocsService["checkTemplate"]>
>;

import {
  normalizeTemplateInputs,
  templateInputNames,
  type RequestTemplateInputs,
  type TemplateInputValues,
} from "../../template-doc/services/template-inputs";

interface ApplyTemplateOptions {
  inputValues?: TemplateInputValues;
  requestInputs?: RequestTemplateInputs;
  creationContext: TemplateCreationContext;
  sourceDocId: string;
  targetDocId?: string;
  title?:
    | string
    | ((
        sourceTitle: string,
        titlePolicy: TemplateTitlePolicy,
      ) => string | undefined);
  variables: TemplateVariables;
  regionalPreferences: RegionalFormatPreferences;
  /** Explicit application day/instant, never reconstructed from formatted text. */
  applicationDate?: TemplateDateInput;
  signal?: AbortSignal;
}

type TemplateDocCreateOptions = Omit<
  DocCreateOptions,
  "isTemplate" | "skipInit"
>;

/** Recovery carries the original target, never a reason to allocate a second
 * document after an ambiguous ACK. The underlying error is not user copy. */
export class DocProvisioningError extends Error {
  constructor(readonly docId: string) {
    super("DOC_PROVISIONING_INCOMPLETE");
    this.name = "DocProvisioningError";
  }
}

type DocSliceSnapshot = NonNullable<ReturnType<Transformer["sliceToSnapshot"]>>;

const logger = new DebugLogger("DocsService");
// A host cache identity inside each real Doc, distinct from anonymous readonly
// stores used by linked-document/BPMN previews. It is never a document ID.
const READONLY_DOC_HOST_ID = "core:readonly-doc-host";

export class DocsService extends Service {
  private readonly templateAbort = new AbortController();

  override dispose() {
    this.templateAbort.abort(new TemplateInstantiationError("cancelled"));
    super.dispose();
  }
  list = this.framework.createEntity(DocRecordList);

  pool = new ObjectPool<string, Doc>({
    onDelete(obj) {
      obj.scope.dispose();
    },
  });

  private readonly readonlyPool = new ObjectPool<string, Doc>({
    onDelete(doc) {
      const page = doc.virgultumDoc;
      doc.scope.dispose();
      page.doc.removeStore({ id: READONLY_DOC_HOST_ID, readonly: true });
      page.dispose();
    },
  });

  /**
   * Get all property values of a property, used for search
   *
   * Results may include docs in trash or deleted docs
   * Legacy property data such as old `journal` will not be included in the values
   */
  propertyValues$(propertyKey: string) {
    if (isNativeMetadataPropertyKey(propertyKey)) {
      return this.store.watchNativeMetadataPropertyValues(propertyKey);
    }
    return combineLatest([
      this.store.watchDocIds(),
      this.docPropertiesStore.watchPropertyAllValues(propertyKey),
    ]).pipe(
      map(([docIds, propertyValues]) => {
        const result = new Map<string, string | undefined>();
        for (const docId of docIds) {
          result.set(docId, propertyValues.get(docId));
        }
        return result;
      }),
    );
  }

  /**
   * used for search
   */
  allDocsCreatedDate$() {
    return this.store.watchAllDocCreateDate();
  }

  /**
   * used for search
   */
  allDocsUpdatedDate$() {
    return this.store.watchAllDocUpdatedDate();
  }

  allDocsTagIds$() {
    return LiveData.computed((get) =>
      Array.from(get(this.list.docsMap$).values(), (record) => ({
        id: record.id,
        tags: get(record.tagIds$),
        confirmed: get(record.tagState$).ids !== null,
      })),
    );
  }

  allDocIds$() {
    return this.store.watchDocIds();
  }

  allNonTrashDocIds$() {
    return this.store.watchNonTrashDocIds();
  }

  allTrashDocIds$() {
    return this.store.watchTrashDocIds();
  }

  allDocTitle$() {
    return this.store.watchAllDocTitle();
  }

  /** Application reads refresh canonical metadata; native-local sources use their offline properties. */
  readTemplateClassification(id: string, signal?: AbortSignal) {
    return this.store.readDocTemplateClassification(id, signal);
  }

  /** Custom-source changes preserve current defaults; Registry metadata stays in Admin. */
  async setTemplateClassification(
    id: string,
    category: string | null,
    tags: string[] | null,
  ) {
    const templates = this.framework.get(TemplateDocService);
    await templates.assertCustomClassificationChange(id, category);
    await this.store.setDocTemplateClassification(id, category, tags);
    templates.invalidateTemplateSuggestions();
  }

  moveManyToTrash(docIds: string[]) {
    const uniqueDocIds = Array.from(new Set(docIds)).filter(Boolean);
    if (uniqueDocIds.length === 0) {
      return;
    }
    const trashDate = Date.now();
    this.store.setManyDocMeta(
      uniqueDocIds.map((id) => ({
        id,
        meta: { trash: true, trashDate },
      })),
    );
  }

  removeManyFromRootMeta(docIds: string[]) {
    this.store.removeManyDocMeta(docIds);
  }

  constructor(
    private readonly store: DocsStore,
    private readonly docPropertiesStore: DocPropertiesStore,
    private readonly docCreateMiddlewares: DocCreateMiddleware[],
  ) {
    super();
  }

  loaded(docId: string) {
    const exists = this.pool.get(docId);
    if (exists) {
      return { doc: exists.obj, release: exists.release };
    }
    return null;
  }

  /** Readonly hosts share the synced leaf while owning their Store and scope.
   * Opening one must not initialize the normal writable Store or its history.
   */
  open(docId: string, { readonly = false }: { readonly?: boolean } = {}) {
    const pool = readonly ? this.readonlyPool : this.pool;
    const docRecord = this.list.doc$(docId).value;
    if (!docRecord) {
      logger.warn("Doc record not found — workspace may still be syncing");
      return null;
    }
    const virgultumDoc = this.store.getVirgultumDoc(docId, {
      readonly,
      id: readonly ? READONLY_DOC_HOST_ID : docId,
    });
    if (!virgultumDoc) {
      logger.warn("Virgultum doc not found");
      return null;
    }

    const exists = pool.get(docId);
    if (exists) {
      return { doc: exists.obj, release: exists.release };
    }

    const docScope = this.framework.createScope(DocScope, {
      docId,
      virgultumDoc,
      record: docRecord,
    });

    try {
      virgultumDoc.load();
    } catch {
      logger.error("Failed to load doc", { reason: "load-failed" });
      if (readonly) {
        docScope.dispose();
        virgultumDoc.doc.removeStore({
          id: READONLY_DOC_HOST_ID,
          readonly: true,
        });
        virgultumDoc.dispose();
        return null;
      }
    }

    const doc = docScope.get(DocService).doc;

    doc.scope.emitEvent(DocInitialized, doc);

    const { obj, release } = pool.put(docId, doc);

    return { doc: obj, release };
  }

  createDoc(options: DocCreateOptions = {}) {
    for (const middleware of this.docCreateMiddlewares) {
      options = middleware.beforeCreate
        ? middleware.beforeCreate(options)
        : options;
    }
    // Root metadata and the leaf page block must start with the same title.
    // Creating the root entry with an empty title would miss the initial leaf
    // mutation because title observation only starts when the editor mounts.
    const id = this.store.createDoc(options.id, options.title);
    const docStore = this.store.getVirgultumDoc(id);
    if (!docStore) {
      throw new Error("Failed to create doc");
    }
    if (options.skipInit !== true) {
      initDocFromProps(docStore, options.docProps, options);
    }
    const docRecord = this.list.doc$(id).value;
    if (!docRecord) {
      throw new Unreachable();
    }
    if (options.primaryMode) {
      void docRecord.setPrimaryMode(options.primaryMode);
    }
    if (options.isTemplate) {
      void docRecord.setTemplateState(true);
    }
    for (const middleware of this.docCreateMiddlewares) {
      middleware.afterCreate?.(docRecord, options);
    }
    docRecord.setCreatedAt(Date.now());
    docRecord.setUpdatedAt(Date.now());
    this.eventBus.emit(DocCreated, {
      doc: docRecord,
      docCreateOptions: options,
    });
    return docRecord;
  }

  recoverDocRegistration(id: string) {
    return this.store.recoverDocRegistration(id);
  }

  /**
   * Create a document-backed template only after content and native attribution
   * have crossed the existing server acknowledgement boundary.
   *
   * The returned record is safe to publish to pickers or registry reports.
   * Failed attempts remain recoverable in trash and may be retried with a new
   * document identity.
   */
  async createTemplateDoc(
    options: TemplateDocCreateOptions & {
      classification?: TemplateSourceClassification;
      body?: DocSliceSnapshot;
    } = {},
    origin?: "custom",
  ) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([this.templateAbort.signal, timeout]);
    let record: ReturnType<DocsService["createDoc"]> | undefined;
    try {
      const { classification, body, ...creation } = options;
      record = await this.createAcknowledgedDoc(creation, signal, body);
      await waitForTemplateOperation(
        this.store.setDocTemplateStateSetting(
          record.id,
          true,
          signal,
          origin,
          classification,
        ),
        signal,
      );
      signal.throwIfAborted();
      return record;
    } catch (error) {
      if (record) {
        this.moveManyToTrash([record.id]);
      }
      throw error;
    }
  }

  /** Copy a frozen native source, retaining literal variables rather than
   * instantiating a working document or copying its Registry ownership. */
  async copyTemplateSource(sourceDocId: string) {
    const signal = AbortSignal.any([
      this.templateAbort.signal,
      AbortSignal.timeout(30_000),
    ]);
    const ref = this.open(sourceDocId, { readonly: true });
    if (!ref) throw new TemplateInstantiationError("source-unavailable");
    try {
      await waitForTemplateOperation(ref.doc.waitForSyncReady(signal), signal);
      await this.store.waitForTemplateSourceSynced(sourceDocId, signal);
      if (!ref.doc.isTemplate$.value || ref.doc.trash$.value)
        throw new TemplateInstantiationError("source-unavailable");
      // Registry sources own their classification in the catalog, not in the
      // document's custom-source metadata.
      const classification = await this.framework
        .get(TemplateDocService)
        .resolveSourceMetadataForDoc(sourceDocId, signal);
      using transformer = this.createDocTransformer(false);
      const source = captureTemplateSource(ref, transformer);
      return await this.createTemplateDoc(
        {
          title: getDuplicatedDocTitle(source.sourceTitle),
          classification: {
            category: classification.category,
            tags: classification.tags ?? [],
          },
          body: source.body,
        },
        "custom",
      );
    } finally {
      ref.release();
    }
  }

  templateOriginValues$() {
    return this.store.watchTemplateOriginValues();
  }

  /** Wait for canonical registration before delivering an attachment. Failure
   * retains the document identity so native audio can retry its original target.
   * Builders can also require the folded root owner to be applied locally before
   * writing classification; worker sync alone does not certify that projection. */
  waitForCreateAcknowledgement(
    id: string,
    signal?: AbortSignal,
    canonicalRoot = false,
  ) {
    return canonicalRoot
      ? this.store.waitForCreateAcknowledgement(id, signal, true)
      : this.store.waitForCreateAcknowledgement(id, signal);
  }

  /** Complete cloud-leaf synchronization, not a local persistence ACK. Native
   * local callers must first use storage's captured-update save contract. */
  waitForDocSynced(id: string, signal?: AbortSignal) {
    return this.store.waitForDocSynced(id, signal);
  }

  /** Import committed native blocks into a new, uninitialized document only.
   * Registration metadata remains owned by the normal document lifecycle.
   * Guides stay ordinary pages; failed creation/attribution trashes only this copy.
   */
  async importNativeTemplateDoc(
    content: Uint8Array,
    title: string,
    purpose: "template" | "guide",
  ) {
    const snapshot =
      content[0] === 0x50 && content[1] === 0x4b
        ? await readNativeTemplateSnapshot(content)
        : undefined;
    const captured = new YDoc();
    try {
      if (!snapshot) {
        applyUpdate(captured, content);
        const blocks = captured.getMap("blocks");
        const pages = [...blocks.values()].filter(
          (block) =>
            block instanceof YMap && block.get("sys:flavour") === "myoxus:page",
        );
        if (
          pages.length !== 1 ||
          [...captured.share.keys()].some((key) => key !== "blocks")
        ) {
          throw new Error(
            "A native document bundle must contain one page and no registration metadata",
          );
        }
      }
    } finally {
      captured.destroy();
    }
    const signal = AbortSignal.any([
      this.templateAbort.signal,
      AbortSignal.timeout(30_000),
    ]);
    let record: ReturnType<DocsService["createDoc"]> | undefined;
    try {
      record = this.createDoc({ title, skipInit: true });
      const store = this.store.getVirgultumDoc(record.id);
      if (!store || store.spaceDoc.getMap("blocks").size !== 0) {
        throw new Error("Native bundle import requires a new empty document");
      }
      if (snapshot) {
        const collection = this.store.getVirgultumCollection();
        for (const [key, blob] of snapshot.assets) {
          await waitForTemplateOperation(
            collection.blobSync.set(key, blob),
            signal,
          );
          if (
            this.store.templateWorkspaceContext.serverBacked &&
            (await waitForTemplateOperation(
              Promise.resolve(collection.blobSync.upload(key)),
              signal,
            )) !== true
          ) {
            throw new Error("Native template artwork could not be uploaded");
          }
        }
        using transformer = this.createDocTransformer(false);
        if (
          !(await transformer.snapshotToBlock(snapshot.snapshot.blocks, store))
        ) {
          throw new Error("Native template snapshot could not be imported");
        }
      } else {
        applyUpdate(store.spaceDoc, content);
      }
      if (!store.root) throw new Error("Native bundle page is unavailable");
      // A skipInit leaf may not yet be connected to the native storage engine.
      // Metadata availability alone cannot acknowledge its imported body.
      await waitForTemplateOperation(
        this.store.waitForDocSynced(record.id, signal),
        signal,
      );
      await waitForTemplateOperation(
        this.waitForCreateAcknowledgement(record.id, signal),
        signal,
      );
      if (purpose === "template") {
        await waitForTemplateOperation(
          this.store.setDocTemplateStateSetting(record.id, true, signal),
          signal,
        );
      }
      signal.throwIfAborted();
      return record;
    } catch (error) {
      if (record) this.moveManyToTrash([record.id]);
      throw error;
    }
  }

  /** Registration still uses the normal document lifecycle. Builders may retain
   * a failed target; default/template callers keep their existing rollback. */
  async createProvisionedDoc(
    options: TemplateDocCreateOptions = {},
    recovery?: { retainOnFailure: true },
  ) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([this.templateAbort.signal, timeout]);
    const id = recovery ? (options.id ?? nanoid()) : undefined;
    try {
      return await this.createAcknowledgedDoc(
        recovery ? { ...options, id } : options,
        signal,
        undefined,
        Boolean(recovery),
      );
    } catch (error) {
      // createDoc/onStoreLoad can fail before returning a DocRecord. Reserve
      // identity outside that call so those failures retain the same target too.
      if (id) throw new DocProvisioningError(id);
      throw error;
    }
  }

  private async createAcknowledgedDoc(
    options: TemplateDocCreateOptions,
    signal: AbortSignal,
    body?: DocSliceSnapshot,
    retainOnFailure = false,
  ) {
    const record = this.createDoc(options);
    try {
      if (body) {
        const doc = this.store.getVirgultumDoc(record.id);
        if (!doc?.root)
          throw new TemplateInstantiationError("application-failed");
        using transformer = this.createDocTransformer();
        const prepared = await waitForTemplateOperation(
          transformer.prepareSlice(structuredClone(body), doc, doc.root.id),
          signal,
        );
        signal.throwIfAborted();
        const includesSurface = body.content.some(
          (block) => block.flavour === "myoxus:surface",
        );
        for (const child of doc.root.children.filter(
          (child) => includesSurface || child.flavour !== "myoxus:surface",
        ))
          doc.deleteBlock(child);
        transformer.commitPreparedSlice(
          prepared,
          doc,
          doc.root.id,
          doc.root.children.length,
          (write) => write(),
        );
      }
      await waitForTemplateOperation(
        this.store.waitForCreateAcknowledgement(record.id, signal),
        signal,
      );
      if (retainOnFailure)
        await this.store.waitForCreateAcknowledgement(record.id, signal, true);
      if (body) await this.store.waitForDocSynced(record.id, signal);
      signal.throwIfAborted();
      return record;
    } catch (error) {
      if (!retainOnFailure) this.moveManyToTrash([record.id]);
      throw error;
    }
  }

  async addLinkedDoc(targetDocId: string, linkedDocId: string) {
    const ref = this.open(targetDocId);
    if (!ref) throw new Error("Doc record not found");
    const { doc, release } = ref;
    const disposePriorityLoad = doc.addPriorityLoad(10);
    await doc.waitForSyncReady();
    disposePriorityLoad();
    const text = new Text([
      {
        insert: " ",
        attributes: {
          reference: {
            type: "LinkedPage",
            pageId: linkedDocId,
          },
        },
      },
    ] as DeltaInsert<MyoxusTextAttributes>[]);
    const [frame] = doc.virgultumDoc.getBlocksByFlavour("myoxus:note");
    frame &&
      doc.virgultumDoc.addBlock(
        "myoxus:paragraph" as never, // TODO(eyhn): fix type
        { text },
        frame.id,
      );
    release();
  }

  changeDocTitle(docId: string, newTitle: string): Promise<void> {
    const generation = this.store.beginDocTitleIntent(docId, newTitle);
    return this.commitDocTitle(docId, newTitle, generation);
  }

  beginDocTitleIntent(docId: string, newTitle: string) {
    return this.store.beginDocTitleIntent(docId, newTitle);
  }

  commitDocTitleIntent(docId: string, newTitle: string, generation: number) {
    return this.commitDocTitle(docId, newTitle, generation);
  }

  async acknowledgeInlineDocTitle(
    docId: string,
    title: string,
    generation: number,
  ) {
    if (!this.store.isCurrentDocTitleIntent(docId, generation)) return;
    try {
      // Local workspaces have no server projection to update their catalog title.
      // The leaf already contains this edit; acknowledge its root metadata only.
      if (!this.store.isServerBackedWorkspace()) {
        this.store.setDocMeta(docId, { title });
      }
      await this.store.waitForDocSynced(docId);
    } catch (error) {
      this.store.failDocTitleIntent(docId, generation);
      throw error;
    }
  }

  private async commitDocTitle(
    docId: string,
    newTitle: string,
    generation: number,
  ) {
    const ref = this.open(docId);
    if (!ref) throw new Error("Doc record not found");
    const { doc, release } = ref;
    const disposePriorityLoad = doc.addPriorityLoad(10);
    let priorityReleased = false;
    const releasePriority = () => {
      if (!priorityReleased) {
        priorityReleased = true;
        disposePriorityLoad();
      }
    };
    try {
      await doc.waitForSyncReady();
      if (!this.store.isCurrentDocTitleIntent(docId, generation)) return;
      doc.changeDocTitle(newTitle, generation);
      // Priority loading is needed to materialize and mutate the leaf doc, not
      // to wait for every sync peer to acknowledge it. Holding the priority
      // through that unbounded wait can starve the next newly created document.
      releasePriority();
      await this.store.waitForDocSynced(docId);
    } catch (error) {
      this.store.failDocTitleIntent(docId, generation);
      throw error;
    } finally {
      releasePriority();
      release();
    }
  }

  prepareTemplateVariables(options: TemplatePreparationOptions) {
    return prepareTemplateValues(options, {
      store: this.store,
      list: this.list,
      folders: () => this.framework.get(FolderStore),
    });
  }

  /** Native snapshot consumers share schema, storage and ID-remapping middleware. */
  createDocTransformer(remapIds = true) {
    const collection = this.store.getVirgultumCollection();
    return new Transformer({
      schema: getMyoxusWorkspaceSchema(),
      blobCRUD: collection.blobSync,
      docCRUD: {
        create: (id: string) => {
          this.createDoc({ id });
          const store = collection.getDoc(id)?.getStore({ id });
          if (!store) throw new Error("Failed to create linked document");
          return store;
        },
        get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
        delete: (id: string) => collection.removeDoc(id),
      },
      middlewares: remapIds
        ? [replaceIdMiddleware(collection.idGenerator)]
        : [],
    });
  }

  private snapshotDocContent(
    docId: string,
    transformer: Transformer,
  ): DocSliceSnapshot {
    const doc = this.store.getVirgultumDoc(docId);
    if (!doc) throw new Error(`Document content not found: ${docId}`);
    const snapshot = transformer.sliceToSnapshot(
      Slice.fromModels(doc, [...(doc.root?.children ?? [])]),
    );
    if (!snapshot) throw new Error(`Failed to snapshot document: ${docId}`);
    return snapshot;
  }

  private async replaceDocContent(
    docId: string,
    snapshot: DocSliceSnapshot,
    transformer: Transformer,
    operation?: { write: (write: () => void) => void },
  ) {
    const doc = this.store.getVirgultumDoc(docId);
    if (!doc) throw new Error(`Document content not found: ${docId}`);
    const remove = () =>
      [...(doc.root?.children ?? [])].forEach((child) =>
        doc.deleteBlock(child),
      );
    if (operation) operation.write(remove);
    else remove();
    const result = await transformer.snapshotToSlice(
      structuredClone(snapshot),
      doc,
      doc.root?.id,
      undefined,
      operation,
    );
    if (!result) throw new TemplateInstantiationError("application-failed");
  }

  private resolveTemplateVariables(
    docId: string,
    variables: TemplateVariables,
  ): string[] {
    const doc = this.store.getVirgultumDoc(docId);
    if (!doc) throw new Error(`Document content not found: ${docId}`);
    return applyNativeTemplateValues(doc, variables);
  }

  async duplicate(sourceDocId: string, _targetDocId?: string) {
    const sourceRecord = this.list.doc$(sourceDocId).value;
    if (!sourceRecord || sourceRecord.trash$.value)
      throw new Error("Source doc record not found");
    const sourceRef = this.open(sourceDocId);
    if (!sourceRef) throw new Error("Source doc record not found");
    const { release: sourceRelease, doc: sourceDoc } = sourceRef;
    let targetRef: ReturnType<DocsService["open"]> = null;
    let createdTarget: DocRecord | undefined;
    try {
      createdTarget = _targetDocId === undefined ? this.createDoc() : undefined;
      const targetDocId = _targetDocId ?? createdTarget!.id;
      targetRef = this.open(targetDocId);
      if (!targetRef) throw new Error("Target doc record not found");
      const { doc: targetDoc } = targetRef;
      await Promise.all([
        sourceDoc.waitForSyncReady(),
        targetDoc.waitForSyncReady(),
      ]);

      // Snapshot conversion owns exact source maps, unresolved heads and native
      // assets. A target ID is not success if content conversion failed.
      using transformer = this.createDocTransformer();
      const snapshot = this.snapshotDocContent(sourceDocId, transformer);
      await this.replaceDocContent(targetDocId, snapshot, transformer);

      // Remote duplication retains SQL identities and archived references through
      // the explicit copy path; it never stages a Yjs assignment for bootstrap.
      const labels = sourceDoc.workspace.scope.get(TagStore);
      const ids = await labels.getPageTags(sourceDocId);
      if (sourceDoc.workspace.flavour !== "local") {
        await waitForDocumentVersionSync(sourceDoc.workspace, targetDocId);
      }
      await labels.setPageTags(targetDocId, ids, sourceDocId);

      targetDoc.changeDocTitle(getDuplicatedDocTitle(sourceDoc.title$.value));

      const properties = sourceDoc.getProperties();
      const removedProperties = [
        "id",
        "isTemplate",
        "journal",
        "primaryMode",
        "pageWidth",
        "edgelessColorTheme",
        "integrationType",
      ];
      removedProperties.forEach((key) => {
        delete properties[key];
      });
      targetDoc.updateProperties(properties);
      return targetDocId;
    } catch (error) {
      // Never trash an explicitly supplied target. A newly allocated failed copy
      // remains recoverable in trash instead of opening as a false success.
      createdTarget?.moveToTrash();
      throw error;
    } finally {
      targetRef?.release();
      sourceRelease();
    }
  }

  /** Journal keeps its target title. Inspect only the body/table inputs, without
   * resolving unrelated account facts or waiting for a write acknowledgement. */
  async readJournalTemplateInputs(sourceDocId: string, signal: AbortSignal) {
    const record = this.list.doc$(sourceDocId).value;
    if (!record || record.trash$.value)
      throw new TemplateInstantiationError("source-unavailable");
    const ref = this.open(sourceDocId);
    if (!ref) throw new TemplateInstantiationError("source-unavailable");
    try {
      await ref.doc.waitForSyncReady(signal);
      signal.throwIfAborted();
      return templateInputNames(
        inspectTemplateSnapshot(
          this.snapshotDocContent(sourceDocId, this.createDocTransformer()),
          "",
        ).required,
      );
    } finally {
      ref.release();
    }
  }

  /** A synchronized, read-only inspection. Its positions expire on any native
   * source transaction; the caller owns release for the displayed result.
   */
  async checkTemplate(sourceDocId: string, signal: AbortSignal) {
    const record = this.list.doc$(sourceDocId).value;
    if (!record || record.trash$.value)
      throw new TemplateInstantiationError("source-unavailable");
    const ref = this.open(sourceDocId);
    if (!ref) throw new TemplateInstantiationError("source-unavailable");
    const stale$ = new LiveData(false);
    const onChange = (transaction: Transaction) => {
      if (transaction.changed.size) stale$.setValue(true);
    };
    let observing = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (observing) ref.doc.yDoc.off("afterTransaction", onChange);
      observing = false;
      ref.release();
    };
    try {
      await ref.doc.waitForSyncReady(signal);
      await this.store.waitForTemplateSourceSynced(sourceDocId, signal);
      signal.throwIfAborted();
      const native = ref.doc.virgultumDoc;
      const snapshot = this.snapshotDocContent(
        sourceDocId,
        this.createDocTransformer(),
      );
      const title =
        (
          native.root?.props as { title?: Text } | undefined
        )?.title?.toString() ?? ref.doc.title$.value;
      const inspection = inspectTemplateSnapshot(
        snapshot,
        title,
        true,
        native.root?.id,
      );
      const revision = encodeStateAsUpdate(ref.doc.yDoc);
      ref.doc.yDoc.on("afterTransaction", onChange);
      observing = true;
      const diagnostics: TemplateCheckDiagnostic[] = inspection.diagnostics.map(
        (d) => ({ ...d, status: "error" }),
      );
      const capabilities = new Set(
        templateVariableCapabilities.map((entry) => entry.name),
      );
      const workspace = this.store.templateWorkspaceContext;
      const reasons = new Map<string, TemplateCheckDiagnostic["reason"]>();
      const statuses = new Map<string, TemplateCheckDiagnostic["status"]>();
      const targetFacts = new Set([
        "creator.name",
        "creator.email",
        "document.created_at.date",
        "document.created_at.time",
        "document.created_at.datetime",
      ]);
      const localFacts = new Set([
        ...optionalProjectTemplateVariableNames,
        ...optionalPreparationTemplateVariableNames,
        "date",
        "date_long",
        "weekday",
        "week",
        "calendar.iso_week_year",
        "month",
        "quarter",
        "year",
        "iso",
      ]);
      // No deferred-creation preflight: that boundary deliberately requires
      // target writes. RequestedValues with no target is the existing read path.
      await Promise.all(
        [...inspection.required].map(async (name) => {
          if (name.startsWith("input.")) {
            statuses.set(name, "input");
            return;
          }
          if (name !== MEMBER_REPEAT_SOURCE && !capabilities.has(name)) {
            reasons.set(name, "unknown-token");
            return;
          }
          if (targetFacts.has(name)) {
            statuses.set(name, "application");
            return;
          }
          if (name === "parent_page_title") {
            statuses.set(name, "context");
            reasons.set(name, "parent-unavailable");
            return;
          }
          if (name === "folder_name" || name === "folder.path") {
            statuses.set(name, "context");
            reasons.set(name, "folder-absent");
            return;
          }
          if (localFacts.has(name)) {
            statuses.set(name, "available");
            return;
          }
          if (name === "workspace.name" && workspace.name?.trim()) {
            statuses.set(name, "available");
            return;
          }
          try {
            const values = await this.store.readTemplateValues(
              [name],
              undefined,
              {},
              signal,
            );
            signal.throwIfAborted();
            if (name === MEMBER_REPEAT_SOURCE)
              validateTemplateRepeats(inspection.repeats, values);
            else if (typeof values[name] !== "string" || !values[name].trim())
              throw new TemplateInstantiationError("empty-field");
            statuses.set(name, "available");
          } catch (error) {
            signal.throwIfAborted();
            reasons.set(
              name,
              error instanceof TemplateInstantiationError
                ? error.reason
                : "metadata-unavailable",
            );
          }
        }),
      );
      for (const unit of inspection.units) {
        let ranges: ReturnType<typeof templateVariableRanges>;
        try {
          // Inspection already collected syntax failures; retain valid
          // neighboring tokens from this same native unit.
          ranges = templateVariableRanges(unit.text, () => {});
        } catch {
          continue;
        }
        for (const range of ranges) {
          if (
            inspection.diagnostics.some(
              (issue) =>
                issue.blockId === unit.blockId &&
                issue.kind === unit.kind &&
                issue.rowId === unit.rowId &&
                issue.columnId === unit.columnId &&
                issue.start === range.start &&
                issue.length === range.length,
            )
          )
            continue;
          const name = range.name;
          if (name.startsWith("member.") && unit.scoped) {
            const reason =
              reasons.get(MEMBER_REPEAT_SOURCE) ??
              (inspection.diagnostics.some(
                (d) =>
                  d.reason === "repeat-invalid" &&
                  d.blockId === unit.blockId &&
                  d.rowId === unit.rowId,
              )
                ? "repeat-invalid"
                : undefined);
            diagnostics.push({
              ...unit,
              ...range,
              name,
              status: reason ? "error" : "available",
              reason,
            });
          } else {
            const reason = reasons.get(name);
            diagnostics.push({
              ...unit,
              ...range,
              name,
              status: statuses.get(name) ?? "error",
              reason,
            });
          }
        }
      }
      return {
        sourceDocId,
        revision,
        diagnostics,
        stale$,
        release,
        isCurrent: () => {
          if (stale$.value) return false;
          const current = encodeStateAsUpdate(ref.doc.yDoc);
          return (
            current.length === revision.length &&
            current.every((byte, index) => byte === revision[index])
          );
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Low-level document operation used only by TemplateInstantiationService.
   * Product surfaces must not bypass the template service because title and
   * regional-variable policy live there.
   */
  async applyTemplate({
    sourceDocId,
    targetDocId: requestedTargetDocId,
    title: titleInput,
    variables,
    inputValues = {},
    requestInputs,
    regionalPreferences,
    applicationDate,
    creationContext,
    signal: operationSignal,
  }: ApplyTemplateOptions): Promise<string> {
    const sourceRecord = this.list.doc$(sourceDocId).value;
    if (!sourceRecord || sourceRecord.trash$.value) {
      throw new TemplateInstantiationError("source-unavailable");
    }
    if (sourceDocId === requestedTargetDocId) {
      throw new TemplateInstantiationError("source-is-target");
    }

    const createdTarget = requestedTargetDocId === undefined;
    let targetDocId = requestedTargetDocId;
    const sourceRef = this.open(sourceDocId);
    let targetRef = targetDocId ? this.open(targetDocId) : null;
    if (!sourceRef || (!createdTarget && !targetRef)) {
      sourceRef?.release();
      targetRef?.release();
      throw new TemplateInstantiationError("source-unavailable");
    }

    const { release: sourceRelease, doc: sourceDoc } = sourceRef;
    let targetSnapshot: DocSliceSnapshot | undefined;
    let transformer: Transformer | undefined;
    let rollbackTransformer: Transformer | undefined;
    let changed = false;
    let ownWrite = false;
    let conflict = false;
    let forwardFinished = false;
    let targetTitle: string | undefined;
    let targetProperties: ReturnType<Doc["getProperties"]> | undefined;
    let copiedPropertyKeys: string[] = [];
    const conflictController = new AbortController();
    // Product callers pass the deadline that began before source validation.
    // The fallback keeps this low-level boundary finite for internal tooling.
    const fallbackController = operationSignal
      ? undefined
      : new AbortController();
    const fallbackTimer = fallbackController
      ? setTimeout(
          () =>
            fallbackController.abort(
              new TemplateInstantiationError("sync-timeout"),
            ),
          30_000,
        )
      : undefined;
    const deadlineSignal = operationSignal ?? fallbackController!.signal;
    const signal = AbortSignal.any([
      deadlineSignal,
      conflictController.signal,
      this.templateAbort.signal,
    ]);
    const onChange = (transaction: Transaction) => {
      if (!ownWrite && transaction.changed.size > 0) {
        conflict = true;
        conflictController.abort(new TemplateInstantiationError("conflict"));
      }
    };
    let observing = false;
    const observations: Subscription[] = [];
    const assertUnchanged = () => {
      if (conflict) throw new TemplateInstantiationError("conflict");
    };
    const write = (callback: () => void) => {
      signal.throwIfAborted();
      if (forwardFinished) throw new TemplateInstantiationError("cancelled");
      assertUnchanged();
      ownWrite = true;
      changed = true;
      try {
        callback();
      } finally {
        ownWrite = false;
      }
    };

    try {
      // Resolve at operation time: the template catalogue itself owns a
      // DocsService-backed list. This also guards callers below the instantiator.
      const metadata = await waitForTemplateOperation(
        this.framework
          .get(TemplateDocService)
          .assertDocumentTemplateSource(sourceDocId, signal),
        signal,
      );
      await Promise.all([
        sourceDoc.waitForSyncReady(signal),
        targetRef?.doc.waitForSyncReady(signal),
      ]);
      transformer = this.createDocTransformer();
      const source = captureTemplateSource(
        sourceRef,
        transformer,
        typeof titleInput === "function"
          ? (title) => titleInput(title, metadata?.titlePolicy ?? "template")
          : titleInput,
      );
      const {
        body: sourceSnapshot,
        title,
        inspection: { required: requested, repeats },
        inputNames: names,
      } = source;
      const properties = { ...source.properties };
      for (const key of [
        "id",
        "createdBy",
        "updatedBy",
        "isTemplate",
        "journal",
        "primaryMode",
        "pageWidth",
        "edgelessColorTheme",
        "integrationType",
      ]) {
        delete properties[key];
      }
      copiedPropertyKeys = Object.keys(properties);
      let inputs = normalizeTemplateInputs([], {});
      if (names.length) {
        try {
          inputs = normalizeTemplateInputs(names, inputValues);
        } catch (error) {
          if (!requestInputs) throw error;
          inputs = normalizeTemplateInputs(
            names,
            await requestInputs(names, signal),
          );
        }
      }
      signal.throwIfAborted();
      const resolved = await this.prepareTemplateVariables({
        sourceDocId,
        targetDocId,
        requested,
        repeats,
        variables,
        inputs,
        creationContext,
        applicationDate,
        regionalPreferences,
        signal,
      });

      // Source capture and all target-independent validation precede creation.
      // Only committed creator/time facts remain pending inside compensation.
      signal.throwIfAborted();
      if (createdTarget) {
        targetDocId = this.createDoc().id;
        targetRef = this.open(targetDocId);
        if (!targetRef)
          throw new TemplateInstantiationError("source-unavailable");
        await waitForTemplateOperation(
          this.store.waitForCreateAcknowledgement(targetDocId, signal),
          signal,
        );
        await targetRef.doc.waitForSyncReady(signal);
      }
      if (!targetRef || !targetDocId)
        throw new TemplateInstantiationError("source-unavailable");
      const targetDoc = targetRef.doc;
      const materializedId = targetDocId;
      targetSnapshot = this.snapshotDocContent(targetDocId, transformer);
      targetTitle = targetDoc.title$.value;
      targetProperties = { ...targetDoc.getProperties() };
      let expectedTitle = targetTitle;
      let expectedProperties = targetProperties;
      const markConflict = () => {
        conflict = true;
        conflictController.abort(new TemplateInstantiationError("conflict"));
      };
      observations.push(
        targetDoc.meta$.subscribe((meta) => {
          if (!observing) return;
          if (ownWrite) expectedTitle = meta.title ?? "";
          else if ((meta.title ?? "") !== expectedTitle || meta.trash)
            markConflict();
        }),
      );
      observations.push(
        targetDoc.properties$.subscribe((value) => {
          if (!observing) return;
          if (ownWrite) expectedProperties = { ...value };
          else if (!isEqual(value, expectedProperties)) markConflict();
        }),
      );
      if (this.store.templateWorkspaceContext.serverBacked)
        observations.push(
          this.store.watchTemplateSyncFailure(targetDocId, () =>
            conflictController.abort(
              new TemplateInstantiationError("cancelled"),
            ),
          ),
        );
      targetDoc.yDoc.on("afterTransaction", onChange);
      observing = true;
      await waitForTemplateOperation(
        this.replaceDocContent(targetDocId, sourceSnapshot, transformer, {
          write,
        }),
        signal,
      );
      Object.assign(
        resolved,
        await this.resolveAutomaticTemplateVariables(
          requested,
          targetDocId,
          regionalPreferences,
          signal,
        ),
      );
      signal.throwIfAborted();
      assertUnchanged();

      let unresolved: string[] = [];
      write(() => {
        unresolved = this.resolveTemplateVariables(materializedId, resolved);
      });
      const resolvedTitle =
        title === undefined
          ? undefined
          : replaceTemplateVariables(title, scalarTemplateVariables(resolved));
      const unresolvedUnique = [...new Set(unresolved)].sort();
      if (unresolvedUnique.length > 0) {
        throw new TemplateInstantiationError("unresolved-variable");
      }
      let propertyWrite: unknown;
      expectedProperties = { ...targetProperties, ...properties };
      write(() => {
        propertyWrite = targetDoc.updateProperties(properties);
      });
      await waitForTemplateOperation(Promise.resolve(propertyWrite), signal);
      signal.throwIfAborted();
      if (resolvedTitle !== undefined) {
        expectedTitle = resolvedTitle;
        write(() => targetDoc.changeDocTitle(resolvedTitle));
      }
      await waitForTemplateOperation(
        this.store.waitForDocSynced(targetDocId, signal),
        signal,
      );
      return targetDocId;
    } catch (error) {
      forwardFinished = true;
      const failure = conflict
        ? new TemplateInstantiationError("conflict", { cause: error })
        : error instanceof TemplateInstantiationError
          ? error
          : signal.aborted
            ? new TemplateInstantiationError("cancelled", {
                cause: signal.reason,
              })
            : new TemplateInstantiationError("application-failed", {
                cause: error,
              });
      logger.error("Template instantiation failed", { reason: failure.reason });
      // A collaborator's work takes precedence over compensation, including on
      // a newly created target. Never trash or restore a concurrently edited doc.
      if (conflict) throw failure;
      const rollbackSignal = AbortSignal.timeout(30_000);
      const rollbackWrite = (callback: () => void) => {
        rollbackSignal.throwIfAborted();
        assertUnchanged();
        ownWrite = true;
        try {
          callback();
        } finally {
          ownWrite = false;
        }
      };
      try {
        const targetDoc = targetRef?.doc;
        if (createdTarget && targetDocId) {
          const createdId = targetDocId;
          rollbackWrite(() => this.moveManyToTrash([createdId]));
        } else if (
          targetDoc &&
          targetDocId &&
          changed &&
          transformer &&
          targetSnapshot
        ) {
          // Restoring is not duplication: retain IDs used by block links and
          // surface relations in the original target snapshot.
          rollbackTransformer = this.createDocTransformer(false);
          await waitForTemplateOperation(
            this.replaceDocContent(
              targetDocId,
              targetSnapshot,
              rollbackTransformer,
              {
                write: rollbackWrite,
              },
            ),
            rollbackSignal,
          );
          let restore: unknown;
          rollbackWrite(() => {
            restore = targetDoc.updateProperties({
              ...Object.fromEntries(
                copiedPropertyKeys.map((key) => [key, null]),
              ),
              ...targetProperties,
            });
            if (targetTitle !== undefined)
              targetDoc.changeDocTitle(targetTitle);
          });
          await waitForTemplateOperation(
            Promise.resolve(restore),
            rollbackSignal,
          );
          await waitForTemplateOperation(
            this.store.waitForDocSynced(targetDocId, rollbackSignal),
            rollbackSignal,
          );
        }
      } catch (rollbackError) {
        const rollbackFailure = new TemplateInstantiationError(
          conflict ? "conflict" : "rollback-failed",
          { cause: rollbackError, targetDocId },
        );
        logger.error("Template target rollback failed", {
          reason: rollbackFailure.reason,
        });
        throw rollbackFailure;
      }
      throw failure;
    } finally {
      forwardFinished = true;
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      if (observing) targetRef?.doc.yDoc.off("afterTransaction", onChange);
      observations.forEach((subscription) => subscription.unsubscribe());
      transformer?.[Symbol.dispose]();
      rollbackTransformer?.[Symbol.dispose]();
      sourceRelease();
      targetRef?.release();
    }
  }

  private async resolveAutomaticTemplateVariables(
    requested: ReadonlySet<string>,
    targetId: string,
    preferences: RegionalFormatPreferences,
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const needsCreator =
      requested.has("creator.name") || requested.has("creator.email");
    const needsTime = [...requested].some((path) =>
      path.startsWith("document.created_at."),
    );
    if (!needsCreator && !needsTime) return {};
    const values = await this.store.readTemplateValues(
      [...requested].filter(
        (path) =>
          path === "creator.name" ||
          path === "creator.email" ||
          path.startsWith("document.created_at."),
      ),
      targetId,
      {},
      signal,
    );
    return formatTemplateCreationValues(requested, values, preferences);
  }

  setDocJournalDate(docId: string, date: string | null) {
    return this.list.doc$(docId).value?.setJournalDate(date);
  }
}
