import { randomUUID } from "node:crypto";
import * as Y from "yjs";

/** Same page/note/paragraph shape as the server lifecycle's YjsDocumentBuilder. */
export function pageRegistrationFixture(title = "Registration recovery") {
  const id = `registration-${randomUUID()}`;
  const content = `Preserved local content ${id}`;
  const doc = new Y.Doc();
  const blocks = doc.getMap<Y.Map<unknown>>("blocks");
  const addBlock = (suffix: string, flavour: string) => {
    const block = new Y.Map<unknown>();
    blocks.set(`${id}-${suffix}`, block);
    block.set("sys:id", `${id}-${suffix}`);
    block.set("sys:flavour", `myoxus:${flavour}`);
    const children = new Y.Array<string>();
    block.set("sys:children", children);
    return { block, children };
  };
  doc.transact(() => {
    const page = addBlock("page", "page");
    page.block.set("prop:title", new Y.Text(title));
    const note = addBlock("note", "note");
    const paragraph = addBlock("paragraph", "paragraph");
    paragraph.block.set("prop:text", new Y.Text(content));
    paragraph.block.set("prop:type", "text");
    page.children.push([`${id}-note`]);
    note.children.push([`${id}-paragraph`]);
  });
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return { id, title, content, update };
}
