import type { MyoxusTextAttributes } from "@virgultum/core/types";
import type { Command } from "@virgultum/core/runtime";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
} from "@virgultum/core/runtime/inline";

import { openLinkEditor } from "./link-editor";

export const toggleLink: Command = (ctx, next) => {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  const inlineRoot = range.startContainer.parentElement?.closest<
    InlineRootElement<MyoxusTextAttributes>
  >(`[${INLINE_ROOT_ATTR}]`);
  if (!inlineRoot) return false;

  const inlineEditor = inlineRoot.inlineEditor;
  const targetInlineRange = inlineEditor.getInlineRange();

  if (!targetInlineRange || ctx.std.store.readonly) return false;

  const format = inlineEditor.getFormat(targetInlineRange);
  if (format.link) {
    inlineEditor.formatText(targetInlineRange, { link: null });
    return next();
  }

  const abortController = new AbortController();
  openLinkEditor(
    ctx.std,
    targetInlineRange.length ? "create" : "insert",
    inlineEditor,
    targetInlineRange,
    abortController,
  );
  return next();
};
