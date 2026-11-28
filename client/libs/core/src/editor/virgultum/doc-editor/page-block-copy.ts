// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrameworkProvider } from "@myoxus/infra";
import {
  docLinkBaseURLMiddleware,
  documentReferenceMiddleware,
  pasteMiddleware,
  replaceIdMiddleware,
  surfaceRefToEmbed,
  uploadMiddleware,
} from "@virgultum/core/adapters";
import {
  bindDocumentCopy,
  clipboardConfigs,
} from "@virgultum/editor/foundation/clipboard";
import { BlockStdScope } from "@virgultum/editor/std";
import {
  Slice,
  type BlockModel,
  type SliceSnapshot,
  type Store,
} from "@virgultum/editor/store";
import { patchDocEmbedService } from "../../view-extensions/editor-view/doc-embed";

/** A block copy owns its frozen slice until delivery or until its source view closes. */
export async function copyPageBlock(
  model: BlockModel,
  framework: FrameworkProvider,
  signal: AbortSignal,
  selection?: SliceSnapshot,
) {
  return copyPageBlocks([model], framework, signal, selection);
}

/** Copy one or more live Page blocks as a Virgultum clipboard slice without an EditorHost. */
export async function copyPageBlocks(
  models: readonly BlockModel[],
  framework: FrameworkProvider,
  signal: AbortSignal,
  selection?: SliceSnapshot,
) {
  const first = models[0];
  if (!first) return;
  const store = first.store;
  signal.throwIfAborted();
  const live = models.filter((m) => store.getModelById(m.id) === m);
  if (!live.length) throw new Error("Clipboard source unavailable");
  const std = new BlockStdScope({
    store,
    extensions: [...clipboardConfigs, patchDocEmbedService(framework)],
  });
  const unbind = bindDocumentCopy(std, false);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unbind();
    std.unmount();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    if (selection) await std.clipboard.copySnapshot(selection);
    else await std.clipboard.copySlice(Slice.fromModels(store, live));
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

/** Paste a captured Virgultum, HTML or Markdown clipboard payload directly into a Store without an EditorHost. */
export async function pastePageClipboard(
  captured: { types: readonly string[]; values: ReadonlyMap<string, string> },
  store: Store,
  framework: FrameworkProvider,
  parentId: string,
  index: number,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if (store.readonly) return false;
  const std = new BlockStdScope({
    store,
    extensions: [...clipboardConfigs, patchDocEmbedService(framework)],
  });
  const paste = pasteMiddleware(std);
  const docLink = docLinkBaseURLMiddleware(store.workspace.id);
  const documentReferences = documentReferenceMiddleware(
    [],
    new Map(),
    undefined,
    { currentDocumentId: store.id },
  );
  const surfaceRef = surfaceRefToEmbed(std);
  const replaceId = replaceIdMiddleware(store.workspace.idGenerator);
  const upload = uploadMiddleware(std);
  std.clipboard.use(paste);
  std.clipboard.use(docLink);
  std.clipboard.use(documentReferences);
  std.clipboard.use(surfaceRef);
  std.clipboard.use(replaceId);
  std.clipboard.use(upload);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    std.clipboard.unuse(paste);
    std.clipboard.unuse(docLink);
    std.clipboard.unuse(documentReferences);
    std.clipboard.unuse(surfaceRef);
    std.clipboard.unuse(replaceId);
    std.clipboard.unuse(upload);
    std.unmount();
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    const syntheticEvent = {
      clipboardData: {
        types: captured.types,
        files: [],
        items: [],
        getData: (type: string) => captured.values.get(type) ?? "",
      },
    } as unknown as ClipboardEvent;
    store.captureSync();
    const inserted = await std.clipboard.paste(
      syntheticEvent,
      store,
      parentId,
      index,
    );
    store.captureSync();
    return Boolean(inserted?.content.length);
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}
