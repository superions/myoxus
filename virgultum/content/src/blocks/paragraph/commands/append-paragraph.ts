import { focusTextModel } from "../../../rich-text/index";
import { getLastNoteBlock } from "@virgultum/core/utils";
import type { Command } from "@virgultum/core/runtime";
import { Text } from "@virgultum/core/store";

/**
 * Append a paragraph block at the end of the whole page.
 */
export const appendParagraphCommand: Command<{ text?: string }> = (
  ctx,
  next,
) => {
  const { std, text = "" } = ctx;
  const { store } = std;
  if (!store.root) return;

  const note = getLastNoteBlock(store);
  let noteId = note?.id;
  if (!noteId) {
    noteId = store.addBlock("myoxus:note", {}, store.root.id);
  }
  const id = store.addBlock(
    "myoxus:paragraph",
    { text: new Text(text) },
    noteId,
  );

  focusTextModel(std, id, text.length);
  next();
};
