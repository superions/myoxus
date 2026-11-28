// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EdgelessClipboardController,
  PageClipboard,
} from "@virgultum/editor/blocks/root";
import { clipboardConfigs } from "@virgultum/editor/foundation/clipboard";
import { defaultImageProxyMiddleware } from "@virgultum/editor/shared/adapters";
import { isInsideEdgelessEditor } from "@virgultum/editor/shared/utils";
import {
  type BlockComponent,
  BlockSelection,
  BlockStdScope,
  Clipboard,
  type EditorHost,
  SurfaceSelection,
  TextSelection,
} from "@virgultum/editor/std";
import { type BlockModel, Slice } from "@virgultum/editor/store";

import { insertFromMarkdown, markDownToDoc } from "../../utils";
import type { AIPanelController } from "../widgets/ai-panel/controller";

function resolveOwningNoteId(block: BlockComponent): string {
  let cursor = block;
  while (cursor.flavour !== "myoxus:note" && cursor.parentComponent) {
    cursor = cursor.parentComponent;
  }
  return cursor.model.id;
}

function selectInsertedBlocks(
  host: EditorHost,
  parent: BlockComponent,
  models: BlockModel[],
): void {
  if (models.length === 0) return;

  const blockSelections = models.map((model) =>
    host.selection.create(BlockSelection, { blockId: model.id }),
  );

  if (isInsideEdgelessEditor(host)) {
    const noteId = resolveOwningNoteId(parent);
    const surfaceSelection = host.selection.create(
      SurfaceSelection,
      blockSelections[0].blockId,
      [noteId],
      true,
    );
    host.selection.set([...blockSelections, surfaceSelection]);
  } else {
    host.selection.setGroup("note", blockSelections);
  }
}

export async function insert(
  host: EditorHost,
  content: string,
  anchorBlock: BlockComponent,
  below = true,
): Promise<void> {
  const parent = anchorBlock.parentComponent;
  if (!parent) return;

  const anchorIndex = parent.model.children.findIndex(
    (child) => child.id === anchorBlock.model.id,
  );
  const insertAt = below ? anchorIndex + 1 : anchorIndex;

  const inserted = await insertFromMarkdown(
    host,
    content,
    host.store,
    parent.model.id,
    insertAt,
  );
  await host.updateComplete;
  requestAnimationFrame(() => selectInsertedBlocks(host, parent, inserted));
}

export async function insertBelow(
  host: EditorHost,
  content: string,
  anchorBlock: BlockComponent,
): Promise<void> {
  await insert(host, content, anchorBlock, true);
}

export async function insertAbove(
  host: EditorHost,
  content: string,
  anchorBlock: BlockComponent,
): Promise<void> {
  await insert(host, content, anchorBlock, false);
}

export async function replace(
  host: EditorHost,
  content: string,
  firstBlock: BlockComponent,
  selectedModels: BlockModel[],
  textSelection?: TextSelection,
): Promise<void> {
  const parent = firstBlock.parentComponent;
  if (!parent) return;

  if (textSelection) {
    const activeSelection = host.selection.find(TextSelection);
    if (!activeSelection?.equals(textSelection)) {
      throw new Error("Markdown replacement selection changed");
    }
    const clipboard =
      host.std.getOptional(PageClipboard) ??
      host.std.getOptional(EdgelessClipboardController);
    if (!clipboard) {
      throw new Error("Native page clipboard unavailable");
    }
    await clipboard.pasteText(content);
    return;
  }

  const firstIndex = parent.model.children.findIndex(
    (child) => child.id === firstBlock.model.id,
  );
  const { store } = host;
  using transformer = store.getTransformer();
  const snapshotBefore = JSON.stringify(
    selectedModels.map((model) => transformer.blockToSnapshot(model)),
  );

  const inserted = await insertFromMarkdown(
    host,
    content,
    store,
    parent.model.id,
    firstIndex,
    firstBlock.model.id,
    () => {
      const drifted =
        selectedModels.some(
          (model) => store.getModelById(model.id) !== model,
        ) ||
        parent.model.children[firstIndex]?.id !== firstBlock.model.id ||
        snapshotBefore !==
          JSON.stringify(
            selectedModels.map((model) => transformer.blockToSnapshot(model)),
          );
      if (drifted) {
        throw new Error("Markdown replacement selection changed");
      }
      store.captureSync();
      for (const model of selectedModels) {
        store.deleteBlock(model);
      }
    },
  );

  await host.updateComplete;
  requestAnimationFrame(() => selectInsertedBlocks(host, parent, inserted));
}

export async function copyText(text: string): Promise<boolean> {
  const previewStore = await markDownToDoc(text, [defaultImageProxyMiddleware]);
  try {
    const models = previewStore
      .getBlocksByFlavour("myoxus:note")
      .flatMap((block) => block.model.children);
    const slice = Slice.fromModels(previewStore, models);
    const scope = new BlockStdScope({
      store: previewStore,
      extensions: [...clipboardConfigs],
    });
    const clipboard = scope.provider.get(Clipboard);
    await clipboard.copySlice(slice);
    return true;
  } finally {
    previewStore.dispose();
  }
}

export async function copyTextAnswer(
  panel: AIPanelController,
): Promise<boolean> {
  if (!panel.answer) return false;
  return copyText(panel.answer);
}
