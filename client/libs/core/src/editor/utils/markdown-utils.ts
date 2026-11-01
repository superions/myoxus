import type { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { expandAnnotationSelection } from "@virgultum/editor/model/annotation";
import {
  DocEmbedProvider,
  NotificationProvider,
} from "@virgultum/editor/shared/services";
import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import {
  defaultImageProxyMiddleware,
  documentReferenceMiddleware,
  docLinkBaseURLMiddleware,
  embedSyncedDocMiddleware,
  MarkdownAdapter,
  hasMarkdownImportDiagnostics,
  type MarkdownImportDiagnostics,
  replaceIdMiddleware,
  PlainTextAdapter,
  prepareMarkdownDocumentExport,
  configureMarkdownReferenceMetas,
  configureMarkdownNativeTargets,
  validMarkdownAnchor,
} from "@virgultum/editor/shared/adapters";
import {
  BlockStdScope,
  type EditorHost,
  type TextRangePoint,
  TextSelection,
} from "@virgultum/editor/std";
import {
  type BlockModel,
  type BlockSnapshot,
  type DraftModel,
  type Slice,
  type SliceSnapshot,
  type Store,
  toDraftModel,
  wrapFakeNote,
  Transformer,
  type TransformerMiddleware,
} from "@virgultum/editor/store";
import { Doc as YDoc } from "yjs";

import { getStoreManager } from "../manager/store";

interface MarkdownWorkspace {
  collection: WorkspaceImpl;
  std: BlockStdScope;
}

let markdownWorkspace: MarkdownWorkspace | null = null;

const getMarkdownWorkspace = (
  featureFlagService?: FeatureFlagService,
): MarkdownWorkspace => {
  if (markdownWorkspace) {
    return markdownWorkspace;
  }

  const collection = new WorkspaceImpl({
    rootDoc: new YDoc({ guid: "markdownToDoc" }),
    featureFlagService: featureFlagService,
  });
  collection.meta.initialize();

  const mockDoc = collection.createDoc("mock-id");
  const std = new BlockStdScope({
    store: mockDoc.getStore(),
    extensions: getStoreManager().config.init().value.get("store"),
  });

  markdownWorkspace = {
    collection,
    std,
  };

  return markdownWorkspace;
};

const updateSnapshotText = (
  point: TextRangePoint,
  snapshot: BlockSnapshot,
  model: DraftModel,
) => {
  const { index, length } = point;
  if (!snapshot.props.text || length === 0) {
    return;
  }
  if (!model.text) return;
  const expanded = expandAnnotationSelection(
    model.text.toDelta(),
    index,
    length,
  );
  (snapshot.props.text as Record<string, unknown>).delta =
    model.text.sliceToDelta(expanded.index, expanded.index + expanded.length);
};

function processSnapshot(
  snapshot: BlockSnapshot,
  text: TextSelection,
  host: EditorHost,
) {
  // The normal transformer already completed a marker's referenced body.
  // A selection endpoint inside that container must not trim it a second time.
  if (snapshot.flavour === "myoxus:footnote-definition") return;
  const model = host.store.getModelById(snapshot.id);
  if (!model) {
    return;
  }

  const modelId = model.id;
  if (text.from.blockId === modelId) {
    updateSnapshotText(text.from, snapshot, toDraftModel(model));
  }
  if (text.to && text.to.blockId === modelId) {
    updateSnapshotText(text.to, snapshot, toDraftModel(model));
  }

  // If the snapshot has children, handle them recursively
  snapshot.children.forEach((childSnapshot) =>
    processSnapshot(childSnapshot, text, host),
  );
}

/**
 * Processes the text in the given snapshot if there is a text selection.
 * Only the selected portion of the snapshot will be processed.
 */
function processTextInSnapshot(snapshot: SliceSnapshot, host: EditorHost) {
  const { content } = snapshot;
  const text = host.selection.find(TextSelection);
  if (!content.length || !text) return;

  content.forEach((snapshot) => processSnapshot(snapshot, text, host));
}

export async function getContentFromSlice(
  host: EditorHost,
  slice: Slice,
  type: "markdown" | "plain-text" = "markdown",
) {
  using transformer = host.std.store.getTransformer([
    documentReferenceMiddleware([]),
    docLinkBaseURLMiddleware(host.std.store.workspace.id),
    embedSyncedDocMiddleware(type === "markdown" ? "reference" : "content"),
  ]);
  const snapshot = transformer.sliceToSnapshot(slice);
  if (!snapshot) {
    return "";
  }
  processTextInSnapshot(snapshot, host);
  if (
    snapshot.content.some(
      (block) => block.flavour === "myoxus:footnote-definition",
    )
  )
    wrapFakeNote(snapshot);
  // Freeze selected text before target loading can yield or move the caret.
  const prepared = await prepareMarkdownDocumentExport(
    host.store,
    host.std.getOptional(DocEmbedProvider) ?? undefined,
    {
      type: "block",
      id: "selection-root",
      flavour: "myoxus:page",
      props: {},
      children: snapshot.content,
    },
  );
  configureMarkdownReferenceMetas(transformer.adapterConfigs, prepared.metas);
  // A selection is not a complete portable document. Targets outside it must
  // retain exact native URLs, not local fragments without exported anchors.
  configureMarkdownNativeTargets(
    transformer.adapterConfigs,
    prepared.nativeTargets,
  );
  for (const meta of prepared.metas)
    transformer.adapterConfigs.set("title:" + meta.id, meta.title);
  const adapter =
    type === "markdown"
      ? new MarkdownAdapter(transformer, host.std.store.provider)
      : new PlainTextAdapter(
          transformer,
          host.std.store.provider,
          host.std.provider,
        );
  const content = await adapter.fromSliceSnapshot({
    snapshot,
    assets: transformer.assetsManager,
  });
  await prepared.assertReadable();
  if (
    adapter instanceof MarkdownAdapter &&
    hasMarkdownImportDiagnostics(adapter.exportDiagnostics)
  )
    host.std
      .getOptional(NotificationProvider)
      ?.notifyMarkdownImportDiagnostics(adapter.exportDiagnostics);
  return content.file;
}

export const markdownToSnapshot = async (
  markdown: string,
  store: Store,
  host?: EditorHost,
  retainedIds?: ReadonlyMap<string, string>,
): Promise<{
  snapshot: SliceSnapshot | null;
  transformer: Transformer;
  diagnostics: MarkdownImportDiagnostics;
  assertCurrent: () => void;
}> => {
  // Preview stores own the output, but only the real editor host owns readable
  // document identities and local targets.
  const referenceStore = host?.store ?? store;
  const middlewares = [
    defaultImageProxyMiddleware,
    docLinkBaseURLMiddleware(referenceStore.workspace.id),
    documentReferenceMiddleware([], new Map(), undefined, {
      currentDocumentId: referenceStore.id,
    }),
    replaceIdMiddleware(store.workspace.idGenerator, retainedIds),
  ];
  const transformer = store.getTransformer(middlewares);
  const markdownAdapter = new MarkdownAdapter(
    transformer,
    store.provider,
    host?.std.provider,
  );
  const payload = {
    file: markdown,
    assets: transformer.assetsManager,
    workspaceId: referenceStore.workspace.id,
    pageId: referenceStore.id,
  };

  // This is preparation, not document creation. Materializing a page here left
  // an unrequested document in the destination collection on every conversion.
  try {
    const snapshot = await markdownAdapter.toSliceSnapshotWithReferences(
      payload,
      referenceStore,
      {
        includeIncomingTargets:
          store.workspace === referenceStore.workspace &&
          store.id === referenceStore.id,
        destination: store,
      },
    );
    return {
      snapshot,
      transformer,
      diagnostics: markdownAdapter.importDiagnostics,
      assertCurrent: () => markdownAdapter.assertImportReferencesCurrent(),
    };
  } catch (error) {
    transformer[Symbol.dispose]();
    throw error;
  }
};

export async function insertFromMarkdown(
  host: EditorHost | undefined,
  markdown: string,
  doc: Store,
  parent?: string,
  index?: number,
  id?: string,
  beforeInsert?: () => void,
) {
  const rootId = doc.root?.id;
  const retainedAnchor = id
    ? (doc.getModelById(id)?.props as { markdownAnchor?: unknown } | undefined)
        ?.markdownAnchor
    : undefined;
  // Seed the normal ID middleware after parsing, before materialization. The
  // same map rewrites incoming local references, not just the first block ID.
  const retainedIds = new Map<string, string>();
  const { snapshot, transformer, assertCurrent } = await markdownToSnapshot(
    markdown,
    doc,
    host,
    retainedIds,
  );
  using job = transformer;
  const snapshots = snapshot?.content.flatMap((x) => x.children) ?? [];
  if (!snapshot || !snapshots.length) {
    if (beforeInsert) throw new Error("Empty Markdown replacement");
    return [];
  }
  if (id) retainedIds.set(snapshots[0].id, id);
  if (
    validMarkdownAnchor(retainedAnchor) &&
    !snapshots[0].props.markdownAnchor &&
    [
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:callout",
      "myoxus:table",
    ].includes(snapshots[0].flavour)
  )
    snapshots[0].props.markdownAnchor = retainedAnchor;
  const imported = await job.snapshotToSlice(
    { ...snapshot, content: snapshots },
    doc,
    parent,
    index,
    {
      beforeInsert: () => {
        if (id && doc.hasBlock(id) && !beforeInsert)
          throw new Error("Markdown insertion block ID collision");
        beforeInsert?.();
      },
      write: (write) => {
        assertCurrent();
        if (
          doc.readonly ||
          !rootId ||
          doc.root?.id !== rootId ||
          !doc.workspace.meta.getDocMeta(doc.id) ||
          (parent && !doc.hasBlock(parent))
        )
          throw new Error("Markdown insertion destination unavailable");
        write();
      },
    },
  );
  if (!imported) throw new Error("Markdown insertion failed");
  return snapshots
    .map(({ id }) => doc.getModelById(id))
    .filter((model): model is BlockModel => !!model);
}

export async function replaceFromMarkdown(
  host: EditorHost | undefined,
  markdown: string,
  doc: Store,
  parent: string,
  index: number,
  id: string,
) {
  const original = doc.getModelById(id);
  if (!original || doc.getParent(original)?.id !== parent)
    throw new Error("Markdown replacement target missing");
  using selectionJob = doc.getTransformer();
  const originalSnapshot = selectionJob.blockToSnapshot(original);
  if (!originalSnapshot)
    throw new Error("Markdown replacement snapshot missing");
  const originalContent = JSON.stringify(originalSnapshot);
  return await insertFromMarkdown(
    host,
    markdown,
    doc,
    parent,
    index,
    id,
    () => {
      if (
        doc.getModelById(id) !== original ||
        doc.getParent(original)?.id !== parent ||
        doc.getParent(original)?.children[index]?.id !== id ||
        JSON.stringify(selectionJob.blockToSnapshot(original)) !==
          originalContent
      )
        throw new Error("Markdown replacement target changed");
      doc.captureSync();
      doc.deleteBlock(original);
    },
  );
}

export async function markDownToDoc(
  answer: string,
  middlewares?: TransformerMiddleware[],
  myoxusFeatureFlagService?: FeatureFlagService,
) {
  const { collection, std } = getMarkdownWorkspace(myoxusFeatureFlagService);

  const transformer = new Transformer({
    schema: std.store.schema,
    blobCRUD: collection.blobSync,
    docCRUD: {
      create: (id: string) => collection.createDoc(id).getStore({ id }),
      get: (id: string) => collection.getDoc(id)?.getStore({ id }) ?? null,
      delete: (id: string) => collection.removeDoc(id),
    },
    middlewares,
  });
  const mdAdapter = new MarkdownAdapter(transformer, std.store.provider);
  const doc = await mdAdapter.toDoc({
    file: answer,
    assets: transformer.assetsManager,
  });
  if (hasMarkdownImportDiagnostics(mdAdapter.importDiagnostics))
    std
      .getOptional(NotificationProvider)
      ?.notifyMarkdownImportDiagnostics(mdAdapter.importDiagnostics);
  if (!doc) {
    console.error("Failed to convert markdown to doc");
  }
  return doc as Store;
}
