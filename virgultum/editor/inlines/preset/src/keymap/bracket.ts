import { insertLinkedNode } from "@virgultum/inline-reference";
import { CodeBlockModel } from "@virgultum/model";
import { getInlineEditorByModel } from "@virgultum/rich-text";
import { BRACKET_PAIRS } from "@virgultum/shared/consts";
import { createDefaultDoc, matchModels } from "@virgultum/shared/utils";
import {
  type BlockStdScope,
  TextSelection,
  type UIEventHandler,
} from "@virgultum/std";
import type { InlineEditor } from "@virgultum/std/inline";

export const bracketKeymap = (
  std: BlockStdScope,
): Record<string, UIEventHandler> => {
  const keymap = BRACKET_PAIRS.reduce(
    (acc, pair) => {
      return {
        ...acc,
        [pair.right]: (ctx) => {
          const { store: doc, selection } = std;
          if (doc.readonly) return;

          const textSelection = selection.find(TextSelection);
          if (!textSelection) return;
          const model = doc.getBlock(textSelection.from.blockId)?.model;
          if (!model) return;
          if (!matchModels(model, [CodeBlockModel])) return;
          const inlineEditor = getInlineEditorByModel(
            std,
            textSelection.from.blockId,
          );
          if (!inlineEditor) return;
          const inlineRange = inlineEditor.getInlineRange();
          if (!inlineRange) return;
          const left = inlineEditor.yText.toString()[inlineRange.index - 1];
          const right = inlineEditor.yText.toString()[inlineRange.index];
          if (pair.left === left && pair.right === right) {
            inlineEditor.setInlineRange({
              index: inlineRange.index + 1,
              length: 0,
            });
            ctx.get("keyboardState").raw.preventDefault();
          }
        },
        [pair.left]: (ctx) => {
          const { store: doc, selection } = std;
          if (doc.readonly) return;

          const textSelection = selection.find(TextSelection);
          if (!textSelection) return;
          const model = doc.getBlock(textSelection.from.blockId)?.model;
          if (!model) return;

          const isCodeBlock = matchModels(model, [CodeBlockModel]);
          // When selection is collapsed, only trigger auto complete in code block
          if (textSelection.isCollapsed() && !isCodeBlock) return;
          if (!textSelection.isInSameBlock()) return;

          ctx.get("keyboardState").raw.preventDefault();

          const inlineEditor = getInlineEditorByModel(
            std,
            textSelection.from.blockId,
          );
          if (!inlineEditor) return;
          const inlineRange = inlineEditor.getInlineRange();
          if (!inlineRange) return;
          const selectedText = inlineEditor.yText
            .toString()
            .slice(inlineRange.index, inlineRange.index + inlineRange.length);
          if (!isCodeBlock && pair.name === "square bracket") {
            // [[Selected text]] becomes a linked document with the selection as its title.
            const success = tryConvertToLinkedDoc(std, inlineEditor);
            if (success) return true;
          }
          inlineEditor.insertText(
            inlineRange,
            pair.left + selectedText + pair.right,
          );

          inlineEditor.setInlineRange({
            index: inlineRange.index + 1,
            length: inlineRange.length,
          });

          return true;
        },
      };
    },
    {} as Record<string, UIEventHandler>,
  );

  return {
    ...keymap,
    "`": (ctx) => {
      const { store: doc, selection } = std;
      if (doc.readonly) return;

      const textSelection = selection.find(TextSelection);
      if (!textSelection || textSelection.isCollapsed()) return;
      if (!textSelection.isInSameBlock()) return;
      const model = doc.getBlock(textSelection.from.blockId)?.model;
      if (!model) return;

      ctx.get("keyboardState").raw.preventDefault();
      const inlineEditor = getInlineEditorByModel(
        std,
        textSelection.from.blockId,
      );
      if (!inlineEditor) return;
      const inlineRange = inlineEditor.getInlineRange();
      if (!inlineRange) return;
      inlineEditor.formatText(inlineRange, { code: true });

      inlineEditor.setInlineRange({
        index: inlineRange.index,
        length: inlineRange.length,
      });

      return true;
    },
  };
};

function tryConvertToLinkedDoc(std: BlockStdScope, inlineEditor: InlineEditor) {
  const root = std.store.root;
  if (!root) return false;
  const linkedDocWidgetEle = std.view.getWidget(
    "myoxus-linked-doc-widget",
    root.id,
  );
  if (!linkedDocWidgetEle) return false;

  const inlineRange = inlineEditor.getInlineRange();
  if (!inlineRange) return false;
  const text = inlineEditor.yText.toString();
  const left = text[inlineRange.index - 1];
  const right = text[inlineRange.index + inlineRange.length];
  const needConvert = left === "[" && right === "]";
  if (!needConvert) return false;

  const docName = text.slice(
    inlineRange.index,
    inlineRange.index + inlineRange.length,
  );
  inlineEditor.deleteText({
    index: inlineRange.index - 1,
    length: inlineRange.length + 2,
  });
  inlineEditor.setInlineRange({ index: inlineRange.index - 1, length: 0 });

  const doc = createDefaultDoc(std.store.workspace, {
    title: docName,
  });
  insertLinkedNode({
    inlineEditor,
    docId: doc.id,
  });
  return true;
}
