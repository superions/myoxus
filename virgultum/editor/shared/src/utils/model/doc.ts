import {
  DEFAULT_PAGE_BLOCK_HEIGHT,
  DEFAULT_PAGE_BLOCK_WIDTH,
} from "@virgultum/model";
import { Text, type Workspace } from "@virgultum/store";

export function createDefaultDoc(
  collection: Workspace,
  options: { id?: string; title?: string } = {},
) {
  const doc = collection.createDoc(options.id);
  doc.load();

  const store = doc.getStore();
  const title = options.title ?? "";
  const rootId = store.addBlock("myoxus:page", {
    title: new Text(title),
  });
  collection.meta.setDocMeta(doc.id, {
    title,
  });

  store.addBlock("myoxus:surface", {}, rootId);
  const noteId = store.addBlock(
    "myoxus:note",
    {
      xywh: `[0, 0, ${DEFAULT_PAGE_BLOCK_WIDTH}, ${DEFAULT_PAGE_BLOCK_HEIGHT}]`,
    },
    rootId,
  );
  store.addBlock("myoxus:paragraph", {}, noteId);
  // To make sure the content of new doc would not be clear
  // By undo operation for the first time
  store.resetHistory();

  return store;
}
