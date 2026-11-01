import { getStoreManager } from "@myoxus/core/editor/manager/store";
import {
  AwarenessStore,
  type Doc,
  type ExtensionType,
  type GetStoreOptions,
  StoreContainer,
  type YBlock,
} from "@virgultum/editor/store";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";

import type { WorkspaceImpl } from "./workspace";

type DocOptions = {
  id: string;
  collection: WorkspaceImpl;
  doc: Y.Doc;
};

type DocRuntime = {
  awarenessStore: AwarenessStore;
  spaceDoc: Y.Doc;
  storeContainer: StoreContainer;
  yBlocks: Y.Map<YBlock>;
};

export class DocImpl implements Doc {
  private readonly _collection: WorkspaceImpl;

  private readonly _initSpaceDoc = () => {
    // Leaf content has its own Y.Doc. Constructing an existing document must
    // not backfill the legacy root `spaces` alias map as a read side effect.
    const spaceDoc = new Y.Doc({ guid: this.id });
    spaceDoc.clientID = this.rootDoc.clientID;
    this._loaded = false;

    return spaceDoc;
  };

  private _runtime?: DocRuntime;

  private readonly _runtimeInitializers = new Set<
    (awarenessStore: AwarenessStore) => void
  >();

  private _loaded = false;

  /** Indicate whether the block tree is ready */
  private _ready = false;

  readonly storeExtensions: ExtensionType[] = [];

  readonly id: string;

  readonly rootDoc: Y.Doc;

  get blobSync() {
    return this.workspace.blobSync;
  }

  get workspace() {
    return this._collection;
  }

  get isEmpty() {
    return this.yBlocks.size === 0;
  }

  get loaded() {
    return this._loaded;
  }

  get meta() {
    return this.workspace.meta.getDocMeta(this.id);
  }

  get ready() {
    return this._ready;
  }

  get spaceDoc() {
    return this._initializeRuntime().spaceDoc;
  }

  get yBlocks() {
    return this._initializeRuntime().yBlocks;
  }

  get awarenessStore() {
    return this._initializeRuntime().awarenessStore;
  }

  /** @internal Exposes allocation state without materializing document content. */
  get runtimeInitialized() {
    return this._runtime !== undefined;
  }

  constructor({ id, collection, doc }: DocOptions) {
    this.id = id;
    this.rootDoc = doc;
    this._collection = collection;
  }

  clear() {
    this.yBlocks.clear();
  }

  get removeStore() {
    return this._initializeRuntime().storeContainer.removeStore;
  }

  /** Registers descriptor-owned setup that must run before runtime consumers. */
  onRuntimeInitialized(initializer: (awarenessStore: AwarenessStore) => void) {
    if (this._runtime) {
      initializer(this._runtime.awarenessStore);
      return () => {};
    }
    this._runtimeInitializers.add(initializer);
    return () => this._runtimeInitializers.delete(initializer);
  }

  private _initializeRuntime(): DocRuntime {
    if (this._runtime) return this._runtime;

    const spaceDoc = this._initSpaceDoc();
    const awarenessStore = new AwarenessStore(new Awareness(spaceDoc));
    const runtime = {
      awarenessStore,
      spaceDoc,
      storeContainer: new StoreContainer(this),
      yBlocks: spaceDoc.getMap<YBlock>("blocks"),
    };
    this._runtime = runtime;

    for (const initializer of this._runtimeInitializers) {
      initializer(awarenessStore);
    }
    this._runtimeInitializers.clear();
    return runtime;
  }

  private _destroy() {
    if (!this._runtime) return;
    this._runtime.awarenessStore.destroy();
    this._runtime.spaceDoc.destroy();
    this._loaded = false;
  }

  dispose() {
    this._destroy();
    this._runtimeInitializers.clear();

    if (this.ready && this._runtime) {
      this._runtime.yBlocks.clear();
    }
  }

  getStore({
    readonly,
    query,
    provider,
    extensions,
    id,
  }: GetStoreOptions = {}) {
    const storeExtensions = getStoreManager()
      .config.init()
      .featureFlag(this.workspace.featureFlagService)
      .value.get("store");
    const exts = storeExtensions
      .concat(extensions ?? [])
      .concat(this.storeExtensions);
    const extensionSet = new Set(exts);

    return this._initializeRuntime().storeContainer.getStore({
      id,
      readonly,
      query,
      provider,
      extensions: Array.from(extensionSet),
    });
  }

  load(initFn?: () => void): this {
    if (this.ready) {
      return this;
    }

    const runtime = this._initializeRuntime();
    runtime.spaceDoc.load();
    this.workspace.onLoadDoc?.(runtime.spaceDoc);
    this.workspace.onLoadAwareness?.(runtime.awarenessStore.awareness);

    initFn?.();

    this._loaded = true;
    this._ready = true;

    return this;
  }

  remove() {
    this._destroy();
    this.rootDoc.getMap("spaces").delete(this.id);
  }
}
