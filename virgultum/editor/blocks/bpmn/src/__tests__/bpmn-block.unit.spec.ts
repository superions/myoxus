// SPDX-License-Identifier: AGPL-3.0-or-later
import { createBlankBpmnSource } from "@myoxus/bpmn-editor/source";
import {
  BpmnBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
  type BpmnBlockModel,
} from "@virgultum/model";
import { type Store, Text } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { bpmnBlockHtmlAdapterMatcher } from "../adapters/html.js";
import { bpmnBlockMarkdownAdapterMatcher } from "../adapters/markdown.js";
import { bpmnBlockPlainTextAdapterMatcher } from "../adapters/plain-text.js";
import { BpmnBlockComponent } from "../bpmn-block.js";
import { remapBpmnClipboardRevisions } from "../clipboard.js";
import { setBpmnBlockTitle } from "../utils.js";
import {
  createBpmnBlockInsertProps,
  insertPreparedBpmnBlock,
} from "../commands.js";
import {
  cloneBpmnSourceRevisionSnapshot,
  commitBpmnSourceRevision,
  readBpmnSourceRevisions,
} from "../source-revisions.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  const doc = workspace.createDoc();
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      BpmnBlockSchemaExtension,
    ],
  });
  const page = store.addBlock("myoxus:page");
  const noteId = store.addBlock("myoxus:note", {}, page);
  const targetId = store.addBlock("myoxus:paragraph", {}, noteId);
  const target = store.getBlock(targetId)!.model;
  cleanups.push(() => {
    store.dispose();
    doc.dispose();
    workspace.dispose();
    workspace.doc.destroy();
  });
  return { store, target, note: store.getBlock(noteId)!.model };
}
function inserted(
  store: Store,
  target: ReturnType<typeof fixture>["target"],
  source: string,
  title?: string,
) {
  const result = insertPreparedBpmnBlock(store, target, {
    ...createBpmnBlockInsertProps({ source }),
    ...(title ? { title: new Text(title) } : {}),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return store.getBlock(result.blockId)!.model as BpmnBlockModel;
}
test("roundtrips exact XML and independent title/revision containers without a frame", async () => {
  const { store, target, note } = fixture();
  const source = "\ufeff" + createBlankBpmnSource().replaceAll("\n", "\r\n");
  const block = inserted(store, target, source, "Procurement");
  expect(note.children.map((child) => child.id)).toEqual([target.id, block.id]);
  expect(block.props.title.toString()).toBe("Procurement");
  const titleText = block.props.title;
  for (const value of [
    "Purchase",
    "Purchase ",
    "Purchase order",
    "Order",
    "",
  ]) {
    setBpmnBlockTitle(block, value);
    expect(block.props.title).toBe(titleText);
    expect(block.props.title.toString()).toBe(value);
  }
  const render = vi.fn((props: { title: string; titleValue: string }) => props);
  const component = {
    model: block,
    store,
    std: { get: () => ({ render }), getOptional: () => undefined },
  } as unknown as BpmnBlockComponent;
  BpmnBlockComponent.prototype.render.call(component);
  const empty = render.mock.calls.at(-1)![0];
  expect(empty.titleValue).toBe("");
  expect(empty.title).not.toBe("");
  setBpmnBlockTitle(block, "Purchase ");
  BpmnBlockComponent.prototype.render.call(component);
  const spaced = render.mock.calls.at(-1)![0];
  expect(spaced.titleValue).toBe("Purchase ");
  expect(spaced.title).toBe("Purchase");
  setBpmnBlockTitle(block, "Procurement");
  expect(block.yBlock.toJSON()).not.toHaveProperty("prop:reference");
  expect(
    [...store.doc.yBlocks.values()].map((value) => value.get("sys:flavour")),
  ).toEqual(["myoxus:page", "myoxus:note", "myoxus:paragraph", "myoxus:bpmn"]);
  store.updateBlock(block, {
    preview: { revision: block.props.selectedHead, sourceId: "cached-preview" },
  });
  const nativeClipboard = store.getTransformer([remapBpmnClipboardRevisions]);
  try {
    const snapshot = nativeClipboard.blockToSnapshot(block)!;
    const pasted = (await nativeClipboard.snapshotToBlock(
      { ...snapshot, id: store.workspace.idGenerator() },
      store,
      note.id,
    )) as BpmnBlockModel;
    expect([...readBpmnSourceRevisions(pasted.yBlock).heads.values()]).toEqual([
      source,
    ]);
    expect(pasted.props.selectedHead).not.toBe(block.props.selectedHead);
    expect(pasted.props.title.toString()).toBe("Procurement");
    pasted.props.title.insert(" copy", pasted.props.title.length);
    expect(block.props.title.toString()).toBe("Procurement");
    expect(pasted.props.preview).toEqual(block.props.preview);
  } finally {
    nativeClipboard[Symbol.dispose]();
  }
});

test("reports failed CRUD, removes only unchanged insertion residue and preserves concurrent edits", () => {
  const { store, target, note } = fixture();
  const props = createBpmnBlockInsertProps();
  const before = [...store.doc.yBlocks.keys()];
  const add = store.addBlock.bind(store);
  const stub = vi
    .spyOn(store, "addBlock")
    .mockImplementation((flavour, values, parent, index) => {
      const id = add(flavour, values, parent, index);
      const children = note.yBlock.get("sys:children") as Y.Array<string>;
      const at = children.toArray().indexOf(id);
      store.transact(() => children.delete(at, 1));
      return id;
    });
  expect(insertPreparedBpmnBlock(store, target, props)).toEqual({
    ok: false,
    code: "BPMN_INSERT_READBACK",
    residueRetained: false,
  });
  expect([...store.doc.yBlocks.keys()]).toEqual(before);
  stub.mockImplementation((flavour, values, parent, index) => {
    const id = add(flavour, values, parent, index);
    store.transact(() => {
      store.doc.yBlocks.get(id)!.set("prop:caption", "concurrent edit");
    });
    return id;
  });
  expect(
    insertPreparedBpmnBlock(store, target, createBpmnBlockInsertProps()),
  ).toEqual({ ok: false, code: "BPMN_INSERT_READBACK", residueRetained: true });
  expect(
    (store.getBlocksByFlavour("myoxus:bpmn")[0].model as BpmnBlockModel).props
      .caption,
  ).toBe("concurrent edit");
});

test("retains concurrent and delayed heads, clones their ancestry, and retires superseded XML outside document undo", () => {
  const { store, target } = fixture();
  const source = createBlankBpmnSource().replace(
    "<process",
    `<process name="${"large payload ".repeat(2000)}"`,
  );
  const block = inserted(store, target, source);
  const heads = block.yBlock.get("prop:sourceHeads") as Y.Map<string>;
  const links = block.yBlock.get("prop:sourceLinks");
  const original = block.props.selectedHead;
  const peer = new Y.Doc();
  cleanups.push(() => peer.destroy());
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(store.doc.spaceDoc));
  const peerBlock = peer.getMap<Y.Map<unknown>>("blocks").get(block.id)!;
  const initialBytes = Y.encodeStateAsUpdate(store.doc.spaceDoc).length;
  const undoEntries = store.history.undoManager.undoStack.length;
  let parent = original;
  for (let index = 0; index < 40; index++) {
    const id = crypto.randomUUID();
    commitBpmnSourceRevision(block.yBlock, {
      id,
      parent,
      source: source.replace("large payload", `edit ${index}`),
      supersedes: [],
    });
    parent = id;
  }
  expect(heads.size).toBe(1);
  expect(block.yBlock.get("prop:sourceHeads")).toBe(heads);
  expect(block.yBlock.get("prop:sourceLinks")).toBe(links);
  expect(store.history.undoManager.undoStack).toHaveLength(undoEntries);
  expect(
    Y.encodeStateAsUpdate(store.doc.spaceDoc).length - initialBytes,
  ).toBeLessThan(40 * 700);
  const competing = crypto.randomUUID();
  commitBpmnSourceRevision(peerBlock, {
    id: competing,
    parent: original,
    source,
    supersedes: [],
  });
  Y.applyUpdate(store.doc.spaceDoc, Y.encodeStateAsUpdate(peer));
  const conflict = readBpmnSourceRevisions(block.yBlock);
  expect(conflict.status).toBe("conflict");
  expect(conflict.selected).toBeNull();
  const clone = cloneBpmnSourceRevisionSnapshot(block.props);
  expect(Object.values(clone.sourceHeads)).toEqual([
    ...conflict.heads.values(),
  ]);
  expect(
    Object.keys(clone.sourceHeads).some((id) => conflict.heads.has(id)),
  ).toBe(false);
  expect(
    commitBpmnSourceRevision(block.yBlock, {
      id: crypto.randomUUID(),
      parent,
      source,
      supersedes: [...conflict.heads.keys()],
    }).status,
  ).toBe("ready");
  expect(heads.size).toBe(1);
  expect(
    commitBpmnSourceRevision(peerBlock, {
      id: crypto.randomUUID(),
      parent: competing,
      source,
      supersedes: [],
    }).heads.size,
  ).toBe(1);
  Y.applyUpdate(store.doc.spaceDoc, Y.encodeStateAsUpdate(peer));
  const delayed = readBpmnSourceRevisions(block.yBlock);
  expect(delayed.status).toBe("conflict");
  expect(delayed.heads.size).toBe(2);
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(store.doc.spaceDoc));
  expect(readBpmnSourceRevisions(peerBlock).heads).toEqual(delayed.heads);
});

test("exports titled safe placeholders without XML payloads or retired frame ownership", async () => {
  const { store, target } = fixture();
  const block = inserted(
    store,
    target,
    createBlankBpmnSource(),
    "Procurement <script>",
  );
  using transformer = store.getTransformer();
  const node = transformer.blockToSnapshot(block)!;
  const output: unknown[] = [];
  for (const adapter of [
    bpmnBlockHtmlAdapterMatcher,
    bpmnBlockMarkdownAdapterMatcher,
  ])
    await adapter.fromBlockSnapshot.enter!(
      { node } as never,
      {
        walkerContext: {
          openNode: (value: unknown) => {
            output.push(value);
            return { closeNode() {} };
          },
        },
      } as never,
    );
  const textBuffer = { content: "" };
  await bpmnBlockPlainTextAdapterMatcher.fromBlockSnapshot.enter!(
    { node } as never,
    { textBuffer } as never,
  );
  const serialized = JSON.stringify(output) + textBuffer.content;
  expect(serialized).toContain("Procurement <script>");
  expect(serialized).not.toContain("<definitions");
  expect(serialized).not.toContain("sourceHeads");
  expect(serialized).not.toContain("Reference");
  expect(output[0]).toMatchObject({
    children: [{ tagName: "figcaption", children: [{ type: "text" }] }],
  });
});
