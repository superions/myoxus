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
import type { MyoxusAIPanelWidget } from "../widgets/ai-panel/ai-panel";

const getNoteId = (blockElement: BlockComponent) => {
  let element = blockElement;
  while (element.flavour !== "myoxus:note") {
    if (!element.parentComponent) {
      break;
    }
    element = element.parentComponent;
  }

  return element.model.id;
};

const setBlockSelection = (
  host: EditorHost,
  parent: BlockComponent,
  models: BlockModel[],
) => {
  const selections = models
    .map((model) => model.id)
    .map((blockId) => host.selection.create(BlockSelection, { blockId }));

  if (isInsideEdgelessEditor(host)) {
    const surfaceElementId = getNoteId(parent);
    const surfaceSelection = host.selection.create(
      SurfaceSelection,
      selections[0].blockId,
      [surfaceElementId],
      true,
    );

    selections.push(surfaceSelection);
    host.selection.set(selections);
  } else {
    host.selection.setGroup("note", selections);
  }
};

export const insert = async (
  host: EditorHost,
  content: string,
  selectBlock: BlockComponent,
  below: boolean = true,
) => {
  const blockParent = selectBlock.parentComponent;
  if (!blockParent) return;
  const index = blockParent.model.children.findIndex(
    (model) => model.id === selectBlock.model.id,
  );
  const insertIndex = below ? index + 1 : index;

  const { store } = host;
  const models = await insertFromMarkdown(
    host,
    content,
    store,
    blockParent.model.id,
    insertIndex,
  );
  await host.updateComplete;
  requestAnimationFrame(() => setBlockSelection(host, blockParent, models));
};

export const insertBelow = async (
  host: EditorHost,
  content: string,
  selectBlock: BlockComponent,
) => {
  await insert(host, content, selectBlock, true);
};

export const insertAbove = async (
  host: EditorHost,
  content: string,
  selectBlock: BlockComponent,
) => {
  await insert(host, content, selectBlock, false);
};

export const replace = async (
  host: EditorHost,
  content: string,
  firstBlock: BlockComponent,
  selectedModels: BlockModel[],
  textSelection?: TextSelection,
) => {
  const firstBlockParent = firstBlock.parentComponent;
  if (!firstBlockParent) return;
  const firstIndex = firstBlockParent.model.children.findIndex(
    (model) => model.id === firstBlock.model.id,
  );

  if (textSelection) {
    const current = host.selection.find(TextSelection);
    if (!current?.equals(textSelection))
      throw new Error("Markdown replacement selection changed");
    const clipboard =
      host.std.getOptional(PageClipboard) ??
      host.std.getOptional(EdgelessClipboardController);
    if (!clipboard) throw new Error("Native page clipboard unavailable");
    await clipboard.pasteText(content);
  } else {
    const { store } = host;
    using selectionJob = store.getTransformer();
    const originalContent = JSON.stringify(
      selectedModels.map((model) => selectionJob.blockToSnapshot(model)),
    );
    const models = await insertFromMarkdown(
      host,
      content,
      store,
      firstBlockParent.model.id,
      firstIndex,
      firstBlock.model.id,
      () => {
        if (
          selectedModels.some(
            (model) => store.getModelById(model.id) !== model,
          ) ||
          firstBlockParent.model.children[firstIndex]?.id !==
            firstBlock.model.id ||
          originalContent !==
            JSON.stringify(
              selectedModels.map((model) =>
                selectionJob.blockToSnapshot(model),
              ),
            )
        )
          throw new Error("Markdown replacement selection changed");
        store.captureSync();
        selectedModels.forEach((model) => store.deleteBlock(model));
      },
    );

    await host.updateComplete;
    requestAnimationFrame(() =>
      setBlockSelection(host, firstBlockParent, models),
    );
  }
};

export const copyTextAnswer = async (panel: MyoxusAIPanelWidget) => {
  if (!panel.answer) {
    return false;
  }
  return copyText(panel.answer);
};

export const copyText = async (text: string) => {
  const previewDoc = await markDownToDoc(text, [defaultImageProxyMiddleware]);
  const models = previewDoc
    .getBlocksByFlavour("myoxus:note")
    .map((b) => b.model)
    .flatMap((model) => model.children);
  const slice = Slice.fromModels(previewDoc, models);
  const std = new BlockStdScope({
    store: previewDoc,
    extensions: [...clipboardConfigs],
  });
  const clipboard = std.provider.get(Clipboard);
  await clipboard.copySlice(slice);
  previewDoc.dispose();
  return true;
};
