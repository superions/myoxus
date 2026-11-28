// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { getElementProps } from "@virgultum/editor/blocks/root";
import { getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import {
  DatabaseBlockModel,
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
  ImageBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
} from "@virgultum/editor/model";
import {
  embedSyncedDocMiddleware,
  MarkdownAdapter,
  titleMiddleware,
} from "@virgultum/editor/shared/adapters";
import {
  getImageSelectionsCommand,
  getSelectedBlocksCommand,
} from "@virgultum/editor/shared/commands";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import {
  getBlockProps,
  isInsideEdgelessEditor,
  matchModels,
} from "@virgultum/editor/shared/utils";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import {
  GfxControllerIdentifier,
  GfxPrimitiveElementModel,
} from "@virgultum/editor/std/gfx";
import {
  type BlockModel,
  type DocSnapshot,
  Slice,
  type Store,
  toDraftModel,
} from "@virgultum/editor/store";
import { Doc as YDoc } from "yjs";

import { getStoreManager } from "../../manager/store";
import type { ChatContextValue } from "../components/ai-chat-content";
import { isAttachment } from "./attachment";
import { canvasToBlob, isImage } from "./image";
import {
  getSelectedAttachments,
  getSelectedImagesAsBlobs,
  getSelectedTextContent,
  selectedToCanvas,
} from "./selection-utils";

export async function extractSelectedContent(
  host: EditorHost,
): Promise<Partial<ChatContextValue> | null> {
  const mode = host.std.get(DocModeProvider).getEditorMode() || "page";
  return mode === "edgeless"
    ? extractEdgelessSelection(host)
    : extractPageSelection(host);
}

async function extractEdgelessSelection(
  host: EditorHost,
): Promise<Partial<ChatContextValue> | null> {
  if (!isInsideEdgelessEditor(host)) return null;

  const selected = host.std.get(GfxControllerIdentifier).selection
    .selectedElements;
  let snapshot: DocSnapshot | null = null;
  let markdown = "";
  const attachments: ChatContextValue["attachments"] = [];
  const images: File[] = [];
  const docs: ChatContextValue["docs"] = [];

  if (selected.length > 0) {
    const transformer = host.store.getTransformer();
    const markdownAdapter = new MarkdownAdapter(
      transformer,
      host.store.provider,
    );
    const scratchWorkspace = new WorkspaceImpl({
      id: "AI_EXTRACT",
      rootDoc: new YDoc({ guid: "AI_EXTRACT" }),
    });
    scratchWorkspace.meta.initialize();

    let hasPrimitives = false;
    let hasNotes = false;
    try {
      const scratchDoc = scratchWorkspace.createDoc();
      const scratchStore = scratchDoc.getStore();
      scratchDoc.load();

      const rootId = scratchStore.addBlock("myoxus:page");
      scratchStore.addBlock("myoxus:surface", {}, rootId);
      const noteId = scratchStore.addBlock("myoxus:note", {}, rootId);
      const surface = getSurfaceBlock(scratchStore);
      if (!surface) {
        throw new Error("Failed to get surface block");
      }

      for (const element of selected) {
        if (element instanceof NoteBlockModel) {
          hasNotes = true;
          for (const child of element.children) {
            scratchStore.addBlock(child.flavour, getBlockProps(child), noteId);
          }
        } else if (isAttachment(element)) {
          const { name, sourceId } = element.props;
          if (name && sourceId) {
            attachments.push({ name, sourceId });
          }
        } else if (isImage(element)) {
          const { sourceId } = element.props;
          if (sourceId) {
            const blob = await host.store.blobSync.get(sourceId);
            if (blob) {
              images.push(new File([blob], sourceId));
            }
          }
        } else if (element instanceof GfxPrimitiveElementModel) {
          hasPrimitives = true;
          surface.addElement(getElementProps(element, new Map()));
        } else if (
          element instanceof EmbedSyncedDocModel ||
          element instanceof EmbedLinkedDocModel
        ) {
          docs.push(element.props.pageId);
        }
      }

      if (hasPrimitives) {
        snapshot = transformer.docToSnapshot(scratchStore) ?? null;
      }
      if (hasNotes) {
        markdown = (await markdownAdapter.fromDoc(scratchStore))?.file ?? "";
      }
    } finally {
      scratchWorkspace.dispose();
    }
  }

  const canvas = await selectedToCanvas(host);
  if (!canvas) return null;

  const previewBlob = await canvasToBlob(canvas);
  if (!previewBlob) return null;

  return {
    images: [new File([previewBlob], "selected.png"), ...images],
    snapshot: snapshot ? JSON.stringify(snapshot) : null,
    combinedElementsMarkdown: markdown.length > 0 ? markdown : null,
    attachments,
    docs,
  };
}

async function extractPageSelection(
  host: EditorHost,
): Promise<Partial<ChatContextValue> | null> {
  const [plainText, images, attachments] = await Promise.all([
    getSelectedTextContent(host, "plain-text"),
    getSelectedImagesAsBlobs(host),
    getSelectedAttachments(host),
  ]);

  const hasText = plainText.length > 0;
  const hasImages = images.length > 0;

  if (hasText && !hasImages) {
    const markdown = await getSelectedTextContent(host, "markdown");
    return { quote: plainText, markdown, attachments };
  }

  if (!hasText && images.length === 1) {
    host.command
      .chain()
      .tryAll((chain) => [chain.pipe(getImageSelectionsCommand)])
      .pipe(getSelectedBlocksCommand, { types: ["image"] })
      .run();
    return { attachments, images };
  }

  const markdown = (await getSelectedTextContent(host, "markdown")).trim();
  return { quote: plainText, markdown, images, attachments };
}

export async function extractMarkdownFromDoc(doc: Store): Promise<string> {
  const scope = new BlockStdScope({
    store: doc,
    extensions: getStoreManager().config.init().value.get("store"),
  });
  const transformer = doc.getTransformer([
    titleMiddleware(doc.workspace.meta.docMetas),
    embedSyncedDocMiddleware("content"),
  ]);
  const adapter = new MarkdownAdapter(transformer, scope.provider);

  const pageNotes = doc
    .getBlocksByFlavour("myoxus:note")
    .map((block) => block.model as NoteBlockModel)
    .filter((note) => note.props.displayMode !== NoteDisplayMode.EdgelessOnly);

  const blocks: BlockModel[] = pageNotes.flatMap((note) => note.children);
  const textDrafts = blocks
    .filter(
      (model) => !matchModels(model, [ImageBlockModel, DatabaseBlockModel]),
    )
    .map(toDraftModel);

  const slice = Slice.fromModels(doc, textDrafts);
  const snapshot = transformer.sliceToSnapshot(slice);
  if (!snapshot) {
    throw new Error("Failed to extract markdown, snapshot is undefined");
  }

  const exported = await adapter.fromSliceSnapshot({
    snapshot,
    assets: transformer.assetsManager,
  });
  return exported.file;
}
