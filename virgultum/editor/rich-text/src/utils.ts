import { effect } from "@preact/signals-core";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import type { BlockStdScope } from "@virgultum/std";
import type { InlineEditor } from "@virgultum/std/inline";
import type { BlockModel } from "@virgultum/store";

import { getInlineEditorByModel } from "./dom";

export function insertContent(
  std: BlockStdScope,
  model: BlockModel,
  text: string,
  attributes?: MyoxusTextAttributes,
) {
  if (!model.text) {
    console.error("Can't insert text! Text not found");
    return;
  }
  const inlineEditor = getInlineEditorByModel(std, model);
  if (!inlineEditor) {
    console.error("Can't insert text! Inline editor not found");
    return;
  }
  const inlineRange = inlineEditor.getInlineRange();
  const index = inlineRange ? inlineRange.index : model.text.length;
  model.text.insert(text, index, attributes as Record<string, unknown>);
  // Update the caret to the end of the inserted text
  inlineEditor.setInlineRange({
    index: index + text.length,
    length: 0,
  });
}

/** Clear pending formatting marks when the caret leaves the current typing sequence. */
export function clearMarksOnDiscontinuousInput(
  inlineEditor: InlineEditor,
): void {
  let inlineRange = inlineEditor.getInlineRange();
  // An effect can stop during its first synchronous run, before its disposer returns.
  effect(
    function () {
      const r = inlineEditor.inlineRange$.value;
      if (
        inlineRange &&
        r &&
        (inlineRange.index === r.index || inlineRange.index === r.index + 1)
      ) {
        inlineRange = r;
      } else {
        inlineEditor.resetMarks();
        this.dispose();
      }
    },
    { name: "editor.richText.clearMarks" },
  );
}

export function getPrefixText(inlineEditor: InlineEditor) {
  const inlineRange = inlineEditor.getInlineRange();
  if (!inlineRange || inlineRange.length > 0) return "";

  const nearestLineBreakIndex = inlineEditor.yTextString
    .slice(0, inlineRange.index)
    .lastIndexOf("\n");
  const prefixText = inlineEditor.yTextString.slice(
    nearestLineBreakIndex + 1,
    inlineRange.index,
  );
  return prefixText;
}
