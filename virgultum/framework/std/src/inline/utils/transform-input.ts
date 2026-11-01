import type { BaseTextAttributes } from "@virgultum/store";

import type { InlineEditor } from "../inline-editor.js";
import type { InlineRange } from "../types.js";
import { expandRangeEmbeds } from "./embed.js";

function handleInsertText<TextAttributes extends BaseTextAttributes>(
  inlineRange: InlineRange,
  data: string | null,
  editor: InlineEditor,
  attributes: TextAttributes,
) {
  if (!data) return;
  editor.insertText(inlineRange, data, attributes);
  editor.setInlineRange({
    index: inlineRange.index + data.length,
    length: 0,
  });
}

function handleInsertReplacementText<TextAttributes extends BaseTextAttributes>(
  inlineRange: InlineRange,
  data: string | null,
  editor: InlineEditor,
  attributes: TextAttributes,
) {
  editor.getDeltasByInlineRange(inlineRange).forEach((deltaEntry) => {
    if (editor.isEmbed(deltaEntry[0])) return;
    attributes = { ...deltaEntry[0].attributes, ...attributes };
  });
  if (data) {
    editor.insertText(inlineRange, data, attributes);
    editor.setInlineRange({
      index: inlineRange.index + data.length,
      length: 0,
    });
  }
}

function handleInsertParagraph(inlineRange: InlineRange, editor: InlineEditor) {
  editor.insertLineBreak(inlineRange);
  editor.setInlineRange({
    index: inlineRange.index + 1,
    length: 0,
  });
}

function handleDelete(inlineRange: InlineRange, editor: InlineEditor) {
  editor.deleteText(inlineRange);
  editor.setInlineRange({
    index: inlineRange.index,
    length: 0,
  });
}

export function transformInput<TextAttributes extends BaseTextAttributes>(
  inputType: string,
  data: string | null,
  attributes: TextAttributes,
  inlineRange: InlineRange,
  editor: InlineEditor,
) {
  if (!editor.isValidInlineRange(inlineRange)) return;
  if (inputType.startsWith("delete") && !inlineRange.length) {
    let offset = 0;
    for (const delta of editor.embedDeltas) {
      const end = offset + delta.insert.length;
      if (
        typeof editor.isEmbed(delta) === "string" &&
        ((inputType.endsWith("Forward") && inlineRange.index === offset) ||
          (inputType.endsWith("Backward") && inlineRange.index === end))
      ) {
        inlineRange = { index: offset, length: delta.insert.length };
        break;
      }
      offset = end;
    }
  }
  inlineRange = expandRangeEmbeds(editor, inlineRange);

  if (inputType === "insertText") {
    handleInsertText(inlineRange, data, editor, attributes);
  } else if (
    inputType === "insertParagraph" ||
    inputType === "insertLineBreak"
  ) {
    handleInsertParagraph(inlineRange, editor);
  } else if (inputType.startsWith("delete")) {
    handleDelete(inlineRange, editor);
  } else if (inputType === "insertReplacementText") {
    // Spell Checker
    handleInsertReplacementText(inlineRange, data, editor, attributes);
  } else {
    return;
  }
}
