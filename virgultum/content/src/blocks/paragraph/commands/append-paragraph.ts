import { focusTextModel } from "../../../rich-text/index";
import { appendPageParagraph } from "@virgultum/core/utils";
import type { Command } from "@virgultum/core/runtime";

/**
 * Append a paragraph block at the end of the whole page.
 */
export const appendParagraphCommand: Command<{ text?: string }> = (
  ctx,
  next,
) => {
  const { std, text = "" } = ctx;
  const id = appendPageParagraph(std.store, text);
  if (!id) return;
  focusTextModel(std, id, text.length);
  next();
};
