import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import {
  NATIVE_BLOCK_SLICE_IMPORT,
  SliceSnapshotSchema,
  wrapFakeNote,
} from "@virgultum/store";
import type {
  BlockSnapshot,
  BlockModel,
  Slice,
  SliceSnapshot,
  Store,
  Transformer,
  TransformerMiddleware,
} from "@virgultum/store";
import DOMPurify from "dompurify";
import * as lz from "lz-string";
import rehypeParse from "rehype-parse";
import { unified } from "unified";

import { LifeCycleWatcher } from "../extension/index.js";
import { TextSelection } from "../selection/index.js";
import { ClipboardAdapterConfigIdentifier } from "./clipboard-adapter.js";
import { onlyContainImgElement } from "./utils.js";

type PreparedPaste = {
  job: Transformer;
  snapshot: SliceSnapshot;
  assertCurrent: () => void;
};

/** A synchronous selection/write fence after async preparation; false cancels. */
type BeforePasteInsert = () => { parent?: string; index?: number } | false;

type CopyPreparation = (
  snapshot: SliceSnapshot,
  job: Transformer,
) => Promise<() => void | Promise<void>>;

/** Decodes the native snapshot attribute; HTML sanitization belongs to the reader. */
export function decodeClipboardSnapshot(encoded: string) {
  return JSON.parse(lz.decompressFromEncodedURIComponent(encoded));
}

export class Clipboard extends LifeCycleWatcher {
  static override key = "clipboard";

  private readonly _pendingPasteJobs = new Set<Transformer>();
  private _generation = 0;
  private _copyPreparation?: CopyPreparation;

  /** The document root owns read policy; Std owns snapshot and OS delivery. */
  setCopyPreparation(prepare: CopyPreparation) {
    const previous = this._copyPreparation;
    this._copyPreparation = prepare;
    return () => {
      if (this._copyPreparation === prepare) {
        this._copyPreparation = previous;
        this._generation++;
      }
    };
  }

  override unmounted() {
    this._generation++;
    for (const job of this._pendingPasteJobs) job[Symbol.dispose]();
    this._pendingPasteJobs.clear();
  }

  protected get _adapters() {
    const adapterConfigs = this.std.provider.getAll(
      ClipboardAdapterConfigIdentifier,
    );
    return Array.from(adapterConfigs.values());
  }

  // Need to be cloned to a map for later use
  private readonly _getDataByType = (clipboardData: DataTransfer) => {
    const data = new Map<string, string | File[]>();
    for (const type of clipboardData.types) {
      if (type === "Files") {
        data.set(type, Array.from(clipboardData.files));
      } else {
        data.set(type, clipboardData.getData(type));
      }
    }
    if (data.get("Files") && data.get("text/html")) {
      const htmlAst = unified()
        .use(rehypeParse)
        .parse(data.get("text/html") as string);

      const isImgOnly =
        htmlAst.children.map(onlyContainImgElement).reduce((a, b) => {
          if (a === "no" || b === "no") {
            return "no";
          }
          if (a === "maybe" && b === "maybe") {
            return "maybe";
          }
          return "yes";
        }, "maybe") === "yes";

      if (isImgOnly) {
        data.delete("text/html");
      }
    }
    return (type: string) => {
      const item = data.get(type);
      if (item) {
        return item;
      }
      const files = (data.get("Files") ?? []) as File[];
      if (files.length > 0) {
        return files;
      }
      return "";
    };
  };

  private readonly _getSnapshotByPriority = async (
    getItem: (type: string) => string | File[],
    doc: Store,
  ): Promise<PreparedPaste | null> => {
    for (const job of this._pendingPasteJobs) {
      if (job.assetsManager.uploadingAssetsMap.size) continue;
      job[Symbol.dispose]();
      this._pendingPasteJobs.delete(job);
    }
    const byPriority = Array.from(this._adapters).sort(
      (a, b) => b.priority - a.priority,
    );

    for (const { adapter, mimeType } of byPriority) {
      const item = getItem(mimeType);
      if (Array.isArray(item)) {
        if (item.length === 0) {
          continue;
        }
        if (
          // if all files are not the same target type, fallback to */*
          !item
            .map((f) => f.type === mimeType || mimeType === "*/*")
            .reduce((a, b) => a && b, true)
        ) {
          continue;
        }
      }
      if (item) {
        const job = this._getJob();
        // Store extensions own adapter matchers while editor-scope extensions own
        // view services such as notifications. Keep both DI boundaries explicit.
        const adapterInstance = new adapter(
          job,
          this.std.store.provider,
          this.std.provider,
        );
        const payload = {
          file: item,
          assets: job.assetsManager,
          workspaceId: doc.workspace.id,
          pageId: doc.id,
        };
        try {
          const snapshot = await adapterInstance.prepareSliceSnapshot(
            payload,
            doc,
          );
          if (snapshot) {
            SliceSnapshotSchema.parse(snapshot);
            return {
              job,
              snapshot,
              assertCurrent: () => adapterInstance.assertPreparedSliceCurrent(),
            };
          }
        } catch (error) {
          job[Symbol.dispose]();
          throw error;
        }
        job[Symbol.dispose]();
      }
    }
    return null;
  };

  private async _insertPreparedPaste(
    prepared: PreparedPaste | null,
    doc: Store,
    generation: number,
    parent?: string,
    index?: number,
    beforeInsert?: BeforePasteInsert,
  ) {
    if (!prepared) return;
    const { job, snapshot, assertCurrent } = prepared;
    let inserting = false;
    try {
      // Unmount invalidates pending loads even when the old selection is unchanged.
      if (generation !== this._generation) return;
      assertCurrent();
      if (doc.readonly) throw new Error("Clipboard destination is read-only");
      job.assertFootnoteDestination(
        snapshot.content,
        doc,
        this.std.selection.find(TextSelection)?.from.blockId,
      );
      if (parent) job.assertFootnoteDestination(snapshot.content, doc, parent);
      const target = beforeInsert?.();
      if (target === false) return;
      inserting = true;
      return await job.snapshotToSlice(
        snapshot,
        doc,
        target?.parent ?? parent,
        target?.index ?? index,
        {
          write: (write) => {
            // Model preparation and insertion batches can yield. Retain the
            // adapter's live dependency fence through the actual writes.
            assertCurrent();
            if (generation !== this._generation || doc.readonly)
              throw new Error("Clipboard destination no longer available");
            write();
          },
        },
      );
    } finally {
      // Image/attachment uploads start when the inserted views mount. Keep that
      // existing owner alive; release completed jobs on the next paste/unmount.
      if (inserting && job.assetsManager.uploadingAssetsMap.size)
        this._pendingPasteJobs.add(job);
      else job[Symbol.dispose]();
    }
  }

  /** Prepare native section data through the same adapter, dependency guards
   * and ID middleware as paste, without touching the OS clipboard or Store.
   */
  async prepareNativeSlice(
    snapshot: SliceSnapshot,
    doc: Store,
    parent: string,
  ) {
    const job = this._getJob();
    const generation = this._generation;
    let inserting = false;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (inserting && job.assetsManager.uploadingAssetsMap.size)
        this._pendingPasteJobs.add(job);
      else job[Symbol.dispose]();
    };
    try {
      const config = this.std.getOptional(
        ClipboardAdapterConfigIdentifier("VIRGULTUM/SNAPSHOT"),
      );
      if (!config) throw new Error("Native clipboard adapter unavailable");
      job.completeLocalFootnoteSlice(snapshot, false);
      const adapter = new config.adapter(job, doc.provider, this.std.provider);
      const parsed = await adapter.prepareSliceSnapshot(
        {
          file: JSON.stringify({ snapshot, blobs: {} }),
          assets: job.assetsManager,
        },
        doc,
      );
      if (!parsed) throw new Error("Native section unavailable");
      job.adapterConfigs.set(NATIVE_BLOCK_SLICE_IMPORT, "true");
      const prepared = await job.prepareSlice(parsed, doc, parent);
      const assertCurrent = () => {
        if (disposed || generation !== this._generation || doc.readonly)
          throw new Error("Native section destination unavailable");
        adapter.assertPreparedSliceCurrent();
      };
      return {
        snapshot: prepared.snapshot,
        assertCurrent,
        commit: (index: number, write: (write: () => void) => void) => {
          assertCurrent();
          inserting = true;
          return job.commitPreparedSlice(
            prepared,
            doc,
            parent,
            index,
            (commit) => {
              assertCurrent();
              write(commit);
            },
          );
        },
        dispose,
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private _jobMiddlewares: TransformerMiddleware[] = [];

  copy = async (slice: Slice) => {
    return this.copySlice(slice);
  };

  /** Freeze the ordinary native copy, including selected text and authorized
   * dependencies, without publishing anything to the operating-system clipboard. */
  prepareCopySlice = async (slice: Slice) => {
    const generation = this._generation;
    const job = this._getJob();
    this._pendingPasteJobs.add(job);
    const dispose = () => {
      this._pendingPasteJobs.delete(job);
      job[Symbol.dispose]();
    };
    try {
      // All formats share one frozen selection and one authorized inventory.
      // Do not re-read a moved caret after asynchronous target/blob loading.
      const snapshot = job.sliceToSnapshot(slice);
      if (!snapshot) throw new Error("Clipboard selection unavailable");
      wrapFakeNote(snapshot);
      const assertPrepared = await this._copyPreparation?.(snapshot, job);
      await Promise.all(
        [...new Set(job.assetsManager.getPathBlobIdMap().values())].map((id) =>
          job.assetsManager.readFromBlob(id),
        ),
      );
      const assertCurrent = async () => {
        await assertPrepared?.();
        if (generation !== this._generation)
          throw new Error("Clipboard source no longer available");
      };
      return { snapshot, job, assertCurrent, [Symbol.dispose]: dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  };

  // Gated by https://developer.mozilla.org/en-US/docs/Glossary/Transient_activation
  copySlice = async (slice: Slice) => {
    using captured = await this.prepareCopySlice(slice);
    const { snapshot, job, assertCurrent } = captured;
    const adapterKeys = this._adapters.map((adapter) => adapter.mimeType);

    await this.writeToClipboard(async (items) => {
      const results = await Promise.allSettled(
        adapterKeys.map(async (type) => {
          const item = await this._getClipboardItem(snapshot, job, type);
          if (typeof item === "string") {
            return [type, item];
          }
          return null;
        }),
      );
      // Wait for every adapter before disposing the shared job. Real conversion
      // failures must not publish a partial clipboard or trigger a cut deletion.
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const filtered = results.flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      );

      return {
        ...items,
        ...Object.fromEntries(filtered),
      };
    }, assertCurrent);
  };

  duplicateSlice = async (
    slice: Slice,
    doc: Store,
    parent?: string,
    index?: number,
    type = "VIRGULTUM/SNAPSHOT",
  ) => {
    const generation = this._generation;
    const selection = JSON.stringify(
      this.std.selection.value.map((item) => item.toJSON()),
    );
    using job = this._getJob();
    const snapshot = job.sliceToSnapshot(slice);
    if (!snapshot) throw new Error("Clipboard selection unavailable");
    wrapFakeNote(snapshot);
    const assertPrepared = await this._copyPreparation?.(snapshot, job);
    await Promise.all(
      [...new Set(job.assetsManager.getPathBlobIdMap().values())].map((id) =>
        job.assetsManager.readFromBlob(id),
      ),
    );
    const items = {
      [type]: await this._getClipboardItem(snapshot, job, type),
    };

    const prepared = await this._getSnapshotByPriority(
      (type) => (items[type] as string | File[]) ?? "",
      doc,
    );
    try {
      await assertPrepared?.();
    } catch (error) {
      prepared?.job[Symbol.dispose]();
      throw error;
    }
    await this._insertPreparedPaste(
      prepared,
      doc,
      generation,
      parent,
      index,
      () =>
        selection ===
        JSON.stringify(this.std.selection.value.map((item) => item.toJSON()))
          ? {}
          : false,
    );
  };

  paste = async (
    event: ClipboardEvent,
    doc: Store,
    parent?: string,
    index?: number,
    beforeInsert?: BeforePasteInsert,
  ) => {
    const generation = this._generation;
    const data = event.clipboardData;
    if (!data) {
      return;
    }

    // Clone native clipboard data during the event, before any async target load.
    const getDataByType = this._getDataByType(data);
    let prepared: PreparedPaste | null = null;
    let hasNativeFootnotes = false;
    try {
      const json = this.readFromClipboard(data);
      const native = json["VIRGULTUM/SNAPSHOT"];
      if (native) {
        const snapshot = JSON.parse(native)?.snapshot;
        hasNativeFootnotes = this._containsFootnotes(
          snapshot?.content ?? [],
          false,
        );
      }
      prepared = await this._getSnapshotByPriority((type) => json[type], doc);
    } catch (error) {
      if (hasNativeFootnotes) throw error;
      // Invalid internal snapshot data may use ordinary MIME preparation. Never
      // retry after materialization: that could duplicate a partial live paste.
    }
    prepared ??= await this._getSnapshotByPriority(getDataByType, doc);
    return this._insertPreparedPaste(
      prepared,
      doc,
      generation,
      parent,
      index,
      beforeInsert,
    );
  };

  /** Programmatic text insertion uses the same adapters and write fences as paste. */
  pasteText = async (
    text: string,
    doc: Store,
    beforeInsert?: BeforePasteInsert,
  ) => {
    const generation = this._generation;
    const prepared = await this._getSnapshotByPriority(
      (type) => (type === "text/plain" ? text : ""),
      doc,
    );
    return this._insertPreparedPaste(
      prepared,
      doc,
      generation,
      undefined,
      undefined,
      beforeInsert,
    );
  };

  pasteBlockSnapshot = async (
    snapshot: BlockSnapshot,
    doc: Store,
    parent?: string,
    index?: number,
  ) => {
    if (this.containsLocalFootnotes([snapshot])) {
      return (
        await this.pasteBlockSnapshots([snapshot], doc, parent, index)
      )[0];
    }
    return this._getJob().snapshotToBlock(snapshot, doc, parent, index);
  };

  /** Route existing native copy consumers through local-target preparation. */
  containsLocalFootnotes(blocks: BlockSnapshot[]): boolean {
    return this._containsFootnotes(blocks, true);
  }

  /** Recognized native footnote failures must not fall back to flattened text. */
  containsFootnotes(blocks: BlockSnapshot[]): boolean {
    return this._containsFootnotes(blocks, false);
  }

  private _containsFootnotes(
    blocks: BlockSnapshot[],
    localOnly: boolean,
  ): boolean {
    const inspect = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(inspect);
      const record = value as Record<string, unknown>;
      const footnote = (
        record.attributes as
          { footnote?: { definitionId?: unknown } } | undefined
      )?.footnote;
      return (
        (localOnly
          ? typeof footnote?.definitionId === "string"
          : footnote != null) || Object.values(record).some(inspect)
      );
    };
    return blocks.some(
      (block) =>
        block.flavour === "myoxus:footnote-definition" ||
        inspect(block.props) ||
        this._containsFootnotes(block.children, localOnly),
    );
  }

  /** Keep a native block-copy batch's shared local targets together. */
  pasteBlockSnapshots = async (
    snapshots: BlockSnapshot[],
    doc: Store,
    parent?: string,
    index?: number,
  ): Promise<BlockModel[]> => {
    if (!this.containsLocalFootnotes(snapshots)) {
      const models: BlockModel[] = [];
      for (let offset = 0; offset < snapshots.length; offset++) {
        const model = await this.pasteBlockSnapshot(
          snapshots[offset],
          doc,
          parent,
          index === undefined ? undefined : index + offset,
        );
        if (!model) throw new Error("Clipboard block unavailable");
        models.push(model);
      }
      return models;
    }
    if (doc.readonly) throw new Error("Clipboard destination is read-only");
    const job = this._getJob();
    let inserting = false;
    try {
      const config = this.std.getOptional(
        ClipboardAdapterConfigIdentifier("VIRGULTUM/SNAPSHOT"),
      );
      if (!config) throw new Error("Native clipboard adapter unavailable");
      const slice: SliceSnapshot = {
        type: "slice",
        content: structuredClone(snapshots),
        workspaceId: this.std.store.workspace.id,
        pageId: this.std.store.id,
      };
      job.completeLocalFootnoteSlice(slice, false);
      const adapter = new config.adapter(
        job,
        this.std.store.provider,
        this.std.provider,
      );
      const prepared = await adapter.prepareSliceSnapshot(
        {
          file: JSON.stringify({ snapshot: slice, blobs: {} }),
          assets: job.assetsManager,
        },
        doc,
      );
      if (!prepared)
        throw new Error("Clipboard local footnote slice unavailable");
      job.adapterConfigs.set(NATIVE_BLOCK_SLICE_IMPORT, "true");
      adapter.assertPreparedSliceCurrent();
      inserting = true;
      const imported = await job.snapshotToSlice(prepared, doc, parent, index, {
        write: (write) => {
          if (doc.readonly)
            throw new Error("Clipboard destination is read-only");
          adapter.assertPreparedSliceCurrent();
          write();
        },
      });
      if (!imported)
        throw new Error("Clipboard local footnote insertion failed");
      return imported.content
        .map((block) => doc.getModelById(block.id))
        .filter((model): model is BlockModel => model !== null);
    } finally {
      if (inserting && job.assetsManager.uploadingAssetsMap.size)
        this._pendingPasteJobs.add(job);
      else job[Symbol.dispose]();
    }
  };

  unuse = (middleware: TransformerMiddleware) => {
    this._jobMiddlewares = this._jobMiddlewares.filter((m) => m !== middleware);
  };

  use = (middleware: TransformerMiddleware) => {
    this._jobMiddlewares.push(middleware);
  };

  get configs() {
    return this._getJob().adapterConfigs;
  }

  private async _getClipboardItem(
    snapshot: SliceSnapshot,
    job: Transformer,
    type: string,
  ) {
    const adapterItem = this.std.getOptional(
      ClipboardAdapterConfigIdentifier(type),
    );
    if (!adapterItem) {
      return;
    }
    const { adapter } = adapterItem;
    const adapterInstance = new adapter(
      job,
      this.std.store.provider,
      this.std.provider,
    );
    const result = await adapterInstance.fromSliceSnapshot({
      snapshot: structuredClone(snapshot),
      assets: job.assetsManager,
    });
    if (!result) {
      return;
    }
    return result.file;
  }

  private _getJob() {
    return this.std.store.getTransformer(this._jobMiddlewares);
  }

  readFromClipboard(clipboardData: DataTransfer) {
    const items = clipboardData.getData("text/html");
    const sanitizedItems = DOMPurify.sanitize(items, {
      FORBID_TAGS: ["svg", "use"],
      USE_PROFILES: { html: true },
    });
    const domParser = new DOMParser();
    const doc = domParser.parseFromString(sanitizedItems, "text/html");
    const dom = doc.querySelector<HTMLDivElement>("[data-virgultum-snapshot]");
    if (!dom) {
      throw new VirgultumError(ErrorCode.TransformerError, "No snapshot found");
    }
    return decodeClipboardSnapshot(dom.dataset.virgultumSnapshot as string);
  }

  sliceToSnapshot(slice: Slice) {
    const job = this._getJob();
    return job.sliceToSnapshot(slice);
  }

  async writeToClipboard(
    updateItems: <T extends Record<string, unknown>>(
      items: T,
    ) => Promise<T> | T,
    assertCurrent?: () => void | Promise<void>,
  ) {
    const items = await updateItems<
      Partial<{
        "text/plain": string;
        "text/html": string;
        "image/png": string | Blob;
      }>
    >({
      "text/plain": "",
      "text/html": "",
      "image/png": "",
    });
    const text = items["text/plain"] ?? "";
    const innerHTML = items["text/html"] ?? "";
    const image = items["image/png"];

    delete items["text/plain"];
    delete items["text/html"];

    const clipboardItems: Record<string, Blob> = {};

    if (image) {
      const type = "image/png";
      delete items[type];
      if (typeof image === "string") {
        clipboardItems[type] = new Blob([image], { type });
      } else if (image instanceof Blob) {
        clipboardItems[type] = image;
      }
    }

    if (text.length > 0) {
      const type = "text/plain";
      clipboardItems[type] = new Blob([text], { type });
    }

    const hasInnerHTML = Boolean(innerHTML.length);
    const isEmpty = Object.keys(clipboardItems).length === 0;

    // If there are no items, fall back to snapshot.
    if (hasInnerHTML || isEmpty) {
      const type = "text/html";
      const snapshot = lz.compressToEncodedURIComponent(JSON.stringify(items));
      const html = `<div data-virgultum-snapshot="${snapshot}">${innerHTML}</div>`;
      clipboardItems[type] = new Blob([html], { type });
    }

    await assertCurrent?.();
    await navigator.clipboard.write([new ClipboardItem(clipboardItems)]);
  }
}
