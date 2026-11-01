import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import type { Command } from "@virgultum/std";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
} from "@virgultum/std/inline";

import { openLinkEditor } from "./link-editor";

export const toggleLink: Command = (ctx, next) => {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (range.collapsed) return false;
  const inlineRoot = range.startContainer.parentElement?.closest<
    InlineRootElement<MyoxusTextAttributes>
  >(`[${INLINE_ROOT_ATTR}]`);
  if (!inlineRoot) return false;

  const inlineEditor = inlineRoot.inlineEditor;
  const targetInlineRange = inlineEditor.getInlineRange();

  if (!targetInlineRange || targetInlineRange.length === 0) return false;

  const format = inlineEditor.getFormat(targetInlineRange);
  if (format.link) {
    inlineEditor.formatText(targetInlineRange, { link: null });
    return next();
  }

  const abortController = new AbortController();
  openLinkEditor(
    ctx.std,
    "create",
    inlineEditor,
    targetInlineRange,
    abortController,
  );
  return next();
};
