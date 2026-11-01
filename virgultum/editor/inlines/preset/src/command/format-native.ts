import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import {
  BLOCK_ID_ATTR,
  type BlockComponent,
  type Command,
} from "@virgultum/std";
import {
  INLINE_ROOT_ATTR,
  type InlineRootElement,
} from "@virgultum/std/inline";

import { FORMAT_NATIVE_SUPPORT_FLAVOURS } from "./consts.js";

// for native range
export const formatNativeCommand: Command<{
  range?: Range;
  styles: MyoxusTextAttributes;
  mode?: "replace" | "merge";
}> = (ctx, next) => {
  const { styles, mode = "merge" } = ctx;

  let range = ctx.range;
  if (!range) {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    range = selection.getRangeAt(0);
  }
  if (!range) return;
  const targetRange = range;

  const selectedInlineEditors = Array.from<InlineRootElement>(
    ctx.std.host.querySelectorAll(`[${INLINE_ROOT_ATTR}]`),
  )
    .filter((el) => targetRange.intersectsNode(el))
    .filter((el) => {
      const block = el.closest<BlockComponent>(`[${BLOCK_ID_ATTR}]`);
      if (block) {
        return FORMAT_NATIVE_SUPPORT_FLAVOURS.includes(block.model.flavour);
      }
      return false;
    })
    .map((el) => el.inlineEditor);

  selectedInlineEditors.forEach((inlineEditor) => {
    // A toolbar popover can own DOM focus while retaining the native Range it
    // was opened for. Resolve that explicit range against each intersecting
    // inline editor instead of consulting focus-dependent live state.
    const inlineRange = inlineEditor.toInlineRange(targetRange);
    if (!inlineRange) return;

    inlineEditor.formatText(inlineRange, styles, {
      mode,
    });
  });

  next();
};
