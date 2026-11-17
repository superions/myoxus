import { REFERENCE_NODE } from "@virgultum/core/consts";
import type { MyoxusInlineEditor } from "@virgultum/core/types";

export function insertLinkedNode({
  inlineEditor,
  docId,
}: {
  inlineEditor: MyoxusInlineEditor;
  docId: string;
}) {
  if (!inlineEditor) return;
  const inlineRange = inlineEditor.getInlineRange();
  if (!inlineRange) return;
  inlineEditor.insertText(inlineRange, REFERENCE_NODE, {
    reference: { type: "LinkedPage", pageId: docId },
  });
  inlineEditor.setInlineRange({
    index: inlineRange.index + 1,
    length: 0,
  });
}
