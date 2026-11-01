import { DisposableGroup } from "@virgultum/global/disposable";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { nextTick } from "@virgultum/global/utils";
import { Subject } from "rxjs";

import { BlockModel } from "../model/block/block-model.js";
import { type DraftModel, toDraftModel } from "../model/block/draft.js";
import type { BlockSchemaType } from "../model/block/zod.js";
import type { Store } from "../model/store/store.js";
import type { Schema } from "../schema/schema.js";
import { AssetsManager } from "./assets.js";
import { BaseBlockTransformer } from "./base.js";
import type {
  AfterExportPayload,
  AfterImportPayload,
  BeforeExportPayload,
  BeforeImportPayload,
  TransformerMiddleware,
  TransformerSlots,
} from "./middleware.js";
import { Slice } from "./slice.js";
import {
  type BlobCRUD,
  type BlockSnapshot,
  BlockSnapshotSchema,
  type DocCRUD,
  type DocSnapshot,
  DocSnapshotSchema,
  type SliceSnapshot,
  SliceSnapshotSchema,
  LOCAL_FOOTNOTE_COPY_BODY,
} from "./type.js";

export type TransformerOptions = {
  schema: Schema;
  blobCRUD: BlobCRUD;
  docCRUD: DocCRUD;
  middlewares?: TransformerMiddleware[];
};

/**
 * An owning operation may fence each synchronous write across async import
 * batches. Its callback must either execute the write synchronously or throw.
 * Without this option, existing paste/import callers retain their behavior.
 */
export type SliceImportOperation = {
  write: (write: () => void) => void;
  /** Runs after every draft converts, before deciding whether live IDs move. */
  beforeInsert?: () => void;
};

interface FlatSnapshot {
  snapshot: BlockSnapshot;
  parentId?: string;
  index?: number;
}

interface DraftBlockTreeNode {
  draft: DraftModel;
  snapshot: BlockSnapshot;
  children: Array<DraftBlockTreeNode>;
}

/** Converted native models bound to the Store used during preparation. */
export interface PreparedSlice {
  readonly snapshot: SliceSnapshot;
  readonly destination: Store;
  readonly tree: DraftBlockTreeNode;
}

// The number of blocks to insert in one batch
const BATCH_SIZE = 100;

export class Transformer {
  private readonly _committedSlices = new WeakSet<PreparedSlice>();
  private readonly _adapterConfigs = new Map<string, string>();

  private readonly _transformerConfigs = new Map<string, unknown>();

  private readonly _assetsManager: AssetsManager;

  private readonly _schema: Schema;

  private readonly _docCRUD: DocCRUD;

  private readonly _disposables: DisposableGroup = new DisposableGroup();

  private readonly _slots: TransformerSlots = {
    beforeImport: new Subject<BeforeImportPayload>(),
    afterImport: new Subject<AfterImportPayload>(),
    beforeExport: new Subject<BeforeExportPayload>(),
    afterExport: new Subject<AfterExportPayload>(),
  };

  blockToSnapshot = (
    model: DraftModel | BlockModel,
  ): BlockSnapshot | undefined => {
    try {
      const draftModel =
        model instanceof BlockModel ? toDraftModel(model) : model;

      const snapshot = this._blockToSnapshot(draftModel);

      if (!snapshot) {
        return;
      }

      BlockSnapshotSchema.parse(snapshot);

      return snapshot;
    } catch (error) {
      console.error(`Error when transforming block to snapshot:`);
      console.error(error);
      return;
    }
  };

  docToSnapshot = (doc: Store): DocSnapshot | undefined => {
    try {
      this._slots.beforeExport.next({
        type: "page",
        page: doc,
      });
      const rootModel = doc.root;
      const meta = this._exportDocMeta(doc);
      if (!rootModel) {
        throw new VirgultumError(
          ErrorCode.TransformerError,
          "Root block not found in doc",
        );
      }
      const blocks = this.blockToSnapshot(toDraftModel(rootModel));
      if (!blocks) {
        return;
      }
      const docSnapshot: DocSnapshot = {
        type: "page",
        meta,
        blocks,
      };
      this._slots.afterExport.next({
        type: "page",
        page: doc,
        snapshot: docSnapshot,
      });
      DocSnapshotSchema.parse(docSnapshot);

      return docSnapshot;
    } catch (error) {
      console.error(`Error when transforming doc to snapshot:`);
      console.error(error);
      return;
    }
  };

  sliceToSnapshot = (slice: Slice): SliceSnapshot | undefined => {
    try {
      this._slots.beforeExport.next({
        type: "slice",
        slice,
      });
      const { content, pageId, workspaceId } = slice.data;
      const contentSnapshot = [];
      for (const block of content) {
        const blockSnapshot = this.blockToSnapshot(block);
        if (!blockSnapshot) {
          return;
        }
        contentSnapshot.push(blockSnapshot);
      }
      const snapshot: SliceSnapshot = {
        type: "slice",
        workspaceId,
        pageId,
        content: contentSnapshot,
      };
      this.completeLocalFootnoteSlice(snapshot);
      this._slots.afterExport.next({
        type: "slice",
        slice,
        snapshot,
      });
      SliceSnapshotSchema.parse(snapshot);

      return snapshot;
    } catch (error) {
      console.error(`Error when transforming slice to snapshot:`);
      console.error(error);
      return;
    }
  };

  /** Complete the existing slice from its loaded source; this never creates a document. */
  completeLocalFootnoteSlice(snapshot: SliceSnapshot, completeBodies = true) {
    // A text selection can contain only a marker. Its body belongs in this
    // same slice, once, before every MIME adapter observes the snapshot.
    const copiedIds = new Map<string, BlockSnapshot>();
    const localTargets = new Set<string>();
    const inspectValue = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(inspectValue);
        return;
      }
      const record = value as Record<string, unknown>;
      const footnote = (
        record.attributes as
          { footnote?: { definitionId?: unknown } } | undefined
      )?.footnote;
      if (typeof footnote?.definitionId === "string")
        localTargets.add(footnote.definitionId);
      Object.values(record).forEach(inspectValue);
    };
    const inspect = (block: BlockSnapshot) => {
      copiedIds.set(block.id, block);
      inspectValue(block.props);
      block.children.forEach(inspect);
    };
    snapshot.content.forEach(inspect);
    const source = localTargets.size ? this.docCRUD.get(snapshot.pageId) : null;
    for (const id of localTargets) {
      // Incoming raw clipboard batches already carry their source bodies. Do
      // not resolve those IDs against the destination's unrelated local tree.
      if (!completeBodies && copiedIds.has(id)) continue;
      const model =
        source?.workspace.id === snapshot.workspaceId
          ? source.getModelById(id)
          : null;
      if (
        model?.flavour !== "myoxus:footnote-definition" ||
        source?.getParent(model)?.flavour !== "myoxus:note"
      )
        throw new Error("Clipboard local footnote definition unavailable");
      // A selection endpoint can be inside this body. Copy the complete body
      // through normal transformers/assets without trimming it to that endpoint.
      const previous = this._adapterConfigs.get(LOCAL_FOOTNOTE_COPY_BODY);
      this._adapterConfigs.set(LOCAL_FOOTNOTE_COPY_BODY, "true");
      let definition: BlockSnapshot | undefined;
      try {
        definition = this.blockToSnapshot(model);
      } finally {
        if (previous === undefined)
          this._adapterConfigs.delete(LOCAL_FOOTNOTE_COPY_BODY);
        else this._adapterConfigs.set(LOCAL_FOOTNOTE_COPY_BODY, previous);
      }
      if (!definition)
        throw new Error("Clipboard local footnote body unavailable");
      const bodyIds = new Set<string>();
      const collect = (node: BlockSnapshot) => {
        bodyIds.add(node.id);
        node.children.forEach(collect);
      };
      definition.children.forEach(collect);
      let replaced = false;
      const complete = (nodes: BlockSnapshot[]): BlockSnapshot[] =>
        nodes.flatMap((node) => {
          if (node.id === id) {
            if (node.flavour !== "myoxus:footnote-definition")
              throw new Error("Conflicting clipboard footnote identity");
            replaced = true;
            return [definition!];
          }
          if (bodyIds.has(node.id)) return [];
          node.children = complete(node.children);
          return [node];
        });
      snapshot.content = complete(snapshot.content);
      if (replaced) continue;
      const note = snapshot.content.find(
        (block) => block.flavour === "myoxus:note",
      );
      (note?.children ?? snapshot.content).push(definition);
    }
  }

  /** A normal paste into a definition body cannot introduce nested markers. */
  assertFootnoteDestination(
    blocks: BlockSnapshot[],
    doc: Store,
    parent?: string,
  ) {
    let model = parent ? doc.getModelById(parent) : null;
    while (model && model.flavour !== "myoxus:footnote-definition")
      model = doc.getParent(model);
    if (!model) return;
    const inspect = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(inspect);
      const record = value as Record<string, unknown>;
      return (
        (record.attributes as { footnote?: unknown } | undefined)?.footnote !=
          null || Object.values(record).some(inspect)
      );
    };
    const inspectBlock = (block: BlockSnapshot): boolean =>
      block.flavour === "myoxus:footnote-definition" ||
      inspect(block.props) ||
      block.children.some(inspectBlock);
    if (blocks.some(inspectBlock))
      throw new Error("Nested footnote references are unsupported");
  }

  snapshotToBlock = async (
    snapshot: BlockSnapshot,
    doc: Store,
    parent?: string,
    index?: number,
  ): Promise<BlockModel | undefined> => {
    try {
      BlockSnapshotSchema.parse(snapshot);
      this.assertFootnoteDestination([snapshot], doc, parent);
      const model = await this._snapshotToBlock(snapshot, doc, parent, index);
      if (!model) return;
      return model;
    } catch (error) {
      console.error(`Error when transforming snapshot to block:`);
      console.error(error);
      return;
    }
  };

  snapshotToDoc = async (snapshot: DocSnapshot): Promise<Store | undefined> => {
    try {
      this._slots.beforeImport.next({
        type: "page",
        snapshot,
      });
      DocSnapshotSchema.parse(snapshot);
      const { meta, blocks } = snapshot;
      const doc = this.docCRUD.create(meta.id);
      doc.load();
      await this.snapshotToBlock(blocks, doc);
      this._slots.afterImport.next({
        type: "page",
        snapshot,
        page: doc,
      });

      return doc;
    } catch (error) {
      console.error(`Error when transforming snapshot to doc:`);
      console.error(error);
      return;
    }
  };

  snapshotToModelData = async (snapshot: BlockSnapshot) => {
    try {
      const { children, flavour, props, id } = snapshot;

      const schema = this._getSchema(flavour);
      const snapshotLeaf = {
        id,
        flavour,
        props,
      };
      const transformer = this._getTransformer(schema);
      const modelData = await transformer.fromSnapshot({
        json: snapshotLeaf,
        assets: this._assetsManager,
        children,
      });

      return modelData;
    } catch (error) {
      console.error(`Error when transforming snapshot to model data:`);
      console.error(error);
      return;
    }
  };

  /** Finish parsing, reference remapping and model conversion before any live
   * write. Existing paste and atomic section insertion share this preparation.
   */
  prepareSlice = async (
    snapshot: SliceSnapshot,
    doc: Store,
    parent?: string,
    index?: number,
    requireComplete = true,
  ): Promise<PreparedSlice> => {
    SliceSnapshotSchema.parse(snapshot);
    this.assertFootnoteDestination(snapshot.content, doc, parent);

    this._slots.beforeImport.next({
      type: "slice",
      snapshot,
    });

    const { content } = snapshot;

    // Create a temporary root snapshot to encompass all content blocks
    const tmpRootSnapshot: BlockSnapshot = {
      id: "temporary-root",
      flavour: "myoxus:page",
      props: {},
      type: "block",
      children: content,
    };

    for (const block of content) {
      this._triggerBeforeImportEvent(block, parent, index);
    }
    const flatSnapshots: FlatSnapshot[] = [];
    this._flattenSnapshot(tmpRootSnapshot, flatSnapshots, parent, index);

    const tree = await this._convertFlatSnapshots(
      flatSnapshots,
      requireComplete,
    );
    return { snapshot, destination: doc, tree };
  };

  /** Commit a prepared section synchronously. Normal paste retains its existing
   * async batching; a section can be one capture unit without an outer Store
   * transaction that would hide newly created parents from their children.
   */
  commitPreparedSlice(
    prepared: PreparedSlice,
    doc: Store,
    parent: string,
    index: number,
    write: (write: () => void) => void,
  ): Slice {
    if (
      prepared.destination !== doc ||
      this._committedSlices.has(prepared) ||
      doc.readonly
    )
      throw new Error("Prepared native section unavailable");
    const visit = (nodes: DraftBlockTreeNode[]) => {
      for (const node of nodes) {
        if (doc.hasBlock(node.draft.id))
          throw new Error("Native section identity already exists");
        visit(node.children);
      }
    };
    visit(prepared.tree.children);
    this._committedSlices.add(prepared);
    const operation: SliceImportOperation = { write };
    const insert = (
      nodes: DraftBlockTreeNode[],
      parentId: string,
      start?: number,
    ) => {
      nodes.forEach((node, offset) => {
        this._insertBlockNode(
          node,
          doc,
          parentId,
          start === undefined ? undefined : start + offset,
          operation,
        );
        insert(node.children, node.draft.id);
      });
    };
    insert(prepared.tree.children, parent, index);
    const slice = new Slice({
      content: prepared.tree.children.map((node) => {
        const model = doc.getModelById(node.draft.id);
        if (!model) throw new Error("Native section model unavailable");
        return toDraftModel(model);
      }),
      workspaceId: prepared.snapshot.workspaceId,
      pageId: prepared.snapshot.pageId,
    });
    write(() =>
      this._slots.afterImport.next({
        type: "slice",
        snapshot: prepared.snapshot,
        slice,
      }),
    );
    return slice;
  }

  snapshotToSlice = async (
    snapshot: SliceSnapshot,
    doc: Store,
    parent?: string,
    index?: number,
    operation?: SliceImportOperation,
  ): Promise<Slice | undefined> => {
    try {
      const { tree: blockTree } = await this.prepareSlice(
        snapshot,
        doc,
        parent,
        index,
        false,
      );
      const { content, workspaceId, pageId } = snapshot;
      const first = content[0];

      if (operation?.beforeInsert) operation.write(operation.beforeInsert);

      // check if the slice is already in the doc
      if (first && doc.hasBlock(first.id)) {
        // if the slice is already in the doc, we need to move the blocks instead of adding them
        const models = content
          .map((block) => doc.getBlock(block.id)?.model)
          .filter(Boolean) as BlockModel[];
        const parentModel = parent ? doc.getBlock(parent)?.model : undefined;
        if (!parentModel) {
          throw new VirgultumError(
            ErrorCode.TransformerError,
            "Parent block not found in doc when moving slice",
          );
        }
        const targetSibling =
          index !== undefined ? parentModel.children[index] : null;
        const move = () => doc.moveBlocks(models, parentModel, targetSibling);
        if (operation) operation.write(move);
        else move();
      } else {
        await this._insertBlockTree(
          blockTree.children,
          doc,
          parent,
          index,
          0,
          operation,
        );
      }

      const contentBlocks = blockTree.children
        .map((tree) => doc.getModelById(tree.draft.id))
        .filter((x): x is BlockModel => x !== null)
        .map((model) => toDraftModel(model));

      const slice = new Slice({
        content: contentBlocks,
        workspaceId,
        pageId,
      });

      const afterSlice = () =>
        this._slots.afterImport.next({
          type: "slice",
          snapshot,
          slice,
        });
      if (operation) operation.write(afterSlice);
      else afterSlice();

      return slice;
    } catch (error) {
      // The owner must distinguish cancellation/conflict/import failure before
      // compensation. Do not turn a fenced operation into undefined success or
      // print its possibly private payload through the legacy import logger.
      if (operation) throw error;
      console.error(`Error when transforming snapshot to slice:`);
      console.error(error);
      return;
    }
  };

  walk = (snapshot: DocSnapshot, callback: (block: BlockSnapshot) => void) => {
    const walk = (block: BlockSnapshot) => {
      try {
        callback(block);
      } catch (error) {
        console.error(`Error when walking snapshot:`);
        console.error(error);
      }

      if (block.children) {
        block.children.forEach(walk);
      }
    };

    walk(snapshot.blocks);
  };

  get adapterConfigs() {
    return this._adapterConfigs;
  }

  get assets() {
    return this._assetsManager.getAssets();
  }

  get assetsManager() {
    return this._assetsManager;
  }

  get schema() {
    return this._schema;
  }

  get docCRUD() {
    return this._docCRUD;
  }

  constructor({
    blobCRUD,
    schema,
    docCRUD,
    middlewares = [],
  }: TransformerOptions) {
    this._assetsManager = new AssetsManager({ blob: blobCRUD });
    this._schema = schema;
    this._docCRUD = docCRUD;

    middlewares.forEach((middleware) => {
      const cleanup = middleware({
        slots: this._slots,
        docCRUD: this._docCRUD,
        assetsManager: this._assetsManager,
        adapterConfigs: this._adapterConfigs,
        transformerConfigs: this._transformerConfigs,
      });
      if (cleanup) {
        this._disposables.add(cleanup);
      }
    });
  }

  private _blockToSnapshot(model: DraftModel): BlockSnapshot | null {
    this._slots.beforeExport.next({
      type: "block",
      model,
    });

    const schema = this._getSchema(model.flavour);
    const transformer = this._getTransformer(schema);
    const snapshotLeaf = transformer.toSnapshot({
      model,
      assets: this._assetsManager,
    });
    const children = model.children
      .map((child) => {
        return this._blockToSnapshot(child);
      })
      .filter(Boolean) as BlockSnapshot[];
    const snapshot: BlockSnapshot = {
      type: "block",
      ...snapshotLeaf,
      children,
    };
    this._slots.afterExport.next({
      type: "block",
      model,
      snapshot,
    });

    return snapshot;
  }

  private async _convertFlatSnapshots(
    flatSnapshots: FlatSnapshot[],
    requireComplete = false,
  ) {
    // Phase 1: Convert snapshots to draft models in series
    // This is not time-consuming, this is faster than Promise.all
    const draftModels = [];
    for (const flat of flatSnapshots) {
      const draft = await this._convertSnapshotToDraftModel(flat);
      if (draft) {
        draft.id = flat.snapshot.id;
      }
      draftModels.push({
        draft,
        snapshot: flat.snapshot,
        parentId: flat.parentId,
        index: flat.index,
      });
    }

    // Phase 2: Filter out the models that failed to convert
    if (
      (requireComplete ||
        flatSnapshots.some(
          ({ snapshot }) => snapshot.flavour === "myoxus:footnote-definition",
        )) &&
      draftModels.some(({ draft }) => !draft)
    )
      throw new VirgultumError(
        ErrorCode.TransformerError,
        "Native snapshot conversion failed before insertion",
      );
    const validDraftModels = draftModels.filter((item) => !!item.draft) as {
      draft: DraftModel;
      snapshot: BlockSnapshot;
      parentId?: string;
      index?: number;
    }[];

    // Phase 3: Rebuild the block trees
    const blockTree = this._rebuildBlockTree(validDraftModels);
    return blockTree;
  }

  private async _convertSnapshotToDraftModel(
    flat: FlatSnapshot,
  ): Promise<DraftModel | undefined> {
    try {
      const { children, flavour } = flat.snapshot;
      const schema = this._getSchema(flavour);
      const transformer = this._getTransformer(schema);
      const { props } = await transformer.fromSnapshot({
        json: {
          id: flat.snapshot.id,
          flavour: flat.snapshot.flavour,
          props: flat.snapshot.props,
        },
        assets: this._assetsManager,
        children,
      });

      return {
        id: flat.snapshot.id,
        flavour: flat.snapshot.flavour,
        children: [],
        props,
      } as unknown as DraftModel;
    } catch (error) {
      console.error(`Error when transforming snapshot to model data:`);
      console.error(error);
      return;
    }
  }

  private _exportDocMeta(doc: Store): DocSnapshot["meta"] {
    const docMeta = doc.meta;

    if (!docMeta) {
      throw new VirgultumError(
        ErrorCode.TransformerError,
        "Doc meta not found",
      );
    }
    return {
      id: docMeta.id,
      title: docMeta.title,
      createDate: docMeta.createDate,
      tags: [], // for backward compatibility
    };
  }

  private _flattenSnapshot(
    snapshot: BlockSnapshot,
    flatSnapshots: FlatSnapshot[],
    parentId?: string,
    index?: number,
  ) {
    flatSnapshots.push({ snapshot, parentId, index });
    if (snapshot.children) {
      snapshot.children.forEach((child, idx) => {
        this._flattenSnapshot(child, flatSnapshots, snapshot.id, idx);
      });
    }
  }

  private _getSchema(flavour: string) {
    const schema = this.schema.flavourSchemaMap.get(flavour);
    if (!schema) {
      throw new VirgultumError(
        ErrorCode.TransformerError,
        `Flavour schema not found for ${flavour}`,
      );
    }
    return schema;
  }

  private _getTransformer(schema: BlockSchemaType) {
    return (
      schema.transformer?.(this._transformerConfigs) ??
      new BaseBlockTransformer(this._transformerConfigs)
    );
  }

  private _insertBlockNode(
    node: DraftBlockTreeNode,
    doc: Store,
    parentId?: string,
    index?: number,
    operation?: SliceImportOperation,
  ) {
    const { draft } = node;
    const { id, flavour, props } = draft;

    const actualIndex = index;
    let targetParent = parentId;
    let targetIndex = actualIndex;
    if (flavour === "myoxus:footnote-definition") {
      // Definitions are parent-local end matter, even when a normal paste's
      // caret is in a list/quote. Their ordinary children keep normal parents.
      let note = parentId ? doc.getModelById(parentId) : null;
      while (note && note.flavour !== "myoxus:note") note = doc.getParent(note);
      note ??=
        doc.root?.children.find((child) => child.flavour === "myoxus:note") ??
        null;
      if (!note) throw new Error("Footnote destination note unavailable");
      targetParent = note.id;
      targetIndex = undefined;
    }
    const insert = () =>
      doc.addBlock(flavour, { id, ...props }, targetParent, targetIndex);
    if (operation) operation.write(insert);
    else insert();

    const model = doc.getBlock(id)?.model;
    if (!model) {
      throw new VirgultumError(
        ErrorCode.TransformerError,
        `Block not found by id ${id}`,
      );
    }

    const afterImport = () =>
      this._slots.afterImport.next({
        type: "block",
        model,
        snapshot: node.snapshot,
      });
    if (operation) operation.write(afterImport);
    else afterImport();
  }

  private async _insertBlockTree(
    nodes: DraftBlockTreeNode[],
    doc: Store,
    parentId?: string,
    startIndex?: number,
    counter: number = 0,
    operation?: SliceImportOperation,
  ) {
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      this._insertBlockNode(
        node,
        doc,
        parentId,
        startIndex === undefined ? undefined : startIndex + index,
        operation,
      );

      counter++;
      if (counter % BATCH_SIZE === 0) {
        await nextTick();
      }

      if (node.children.length > 0) {
        counter = await this._insertBlockTree(
          node.children,
          doc,
          node.draft.id,
          undefined,
          counter,
          operation,
        );
      }
    }

    return counter;
  }

  private _rebuildBlockTree(
    draftModels: {
      draft: DraftModel;
      snapshot: BlockSnapshot;
      parentId?: string;
      index?: number;
    }[],
  ): DraftBlockTreeNode {
    const nodeMap = new Map<string, DraftBlockTreeNode>();
    // First pass: create nodes and add them to the map
    draftModels.forEach(({ draft, snapshot }) => {
      nodeMap.set(draft.id, { draft, snapshot, children: [] });
    });
    const root = nodeMap.get(draftModels[0].draft.id) as DraftBlockTreeNode;

    // Second pass: build the tree structure
    draftModels.forEach(({ draft, parentId, index }) => {
      const node = nodeMap.get(draft.id);
      if (!node) return;

      if (parentId) {
        const parentNode = nodeMap.get(parentId);
        if (parentNode && index !== undefined) {
          parentNode.children[index] = node;
        }
      }
    });

    if (!root) {
      throw new Error("No root node found in the tree");
    }

    return root;
  }

  private async _snapshotToBlock(
    snapshot: BlockSnapshot,
    doc: Store,
    parent?: string,
    index?: number,
  ): Promise<BlockModel | null> {
    this._triggerBeforeImportEvent(snapshot, parent, index);

    const flatSnapshots: FlatSnapshot[] = [];
    this._flattenSnapshot(snapshot, flatSnapshots, parent, index);

    const blockTree = await this._convertFlatSnapshots(flatSnapshots);

    await this._insertBlockTree([blockTree], doc, parent, index);

    return doc.getBlock(snapshot.id)?.model ?? null;
  }

  private _triggerBeforeImportEvent(
    snapshot: BlockSnapshot,
    parent?: string,
    index?: number,
  ) {
    const traverseAndTrigger = (
      node: BlockSnapshot,
      parent?: string,
      index?: number,
    ) => {
      this._slots.beforeImport.next({
        type: "block",
        snapshot: node,
        parent: parent,
        index: index,
      });
      if (node.children) {
        node.children.forEach((child, idx) => {
          traverseAndTrigger(child, node.id, idx);
        });
      }
    };
    traverseAndTrigger(snapshot, parent, index);
  }

  reset() {
    this._assetsManager.cleanup();
  }

  [Symbol.dispose]() {
    this._disposables.dispose();
    this._assetsManager.cleanup();
  }
}
