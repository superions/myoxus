import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import type { BlockModel, Store } from "../model/index.js";
import { createAutoIncrementIdGenerator } from "../test/index.js";
import { TestWorkspace } from "../test/test-workspace.js";
import {
  DividerBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  type RootBlockModel,
  RootBlockSchemaExtension,
} from "./test-schema.js";

const extensions = [
  RootBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  DividerBlockSchemaExtension,
];

function createTestOptions() {
  const idGenerator = createAutoIncrementIdGenerator();
  return { id: "test-collection", idGenerator };
}

test("trigger props updated", () => {
  const options = createTestOptions();
  const collection = new TestWorkspace(options);
  collection.meta.initialize();

  const doc = collection.createDoc("home");
  doc.load();
  const store = doc.getStore({
    extensions,
  });

  store.addBlock("myoxus:page");

  const rootModel = store.root as RootBlockModel;

  expect(rootModel.id).toBe("0");
  expect(rootModel.flavour).toBe("myoxus:page");

  const onPropsUpdated = vi.fn();
  rootModel.propsUpdated.subscribe(onPropsUpdated);

  const getColor = () =>
    (rootModel.yBlock.get("prop:style") as Y.Map<string>).get("color");

  const getItems = () => rootModel.yBlock.get("prop:items") as Y.Array<unknown>;
  const getCount = () => rootModel.yBlock.get("prop:count");

  rootModel.props.count = 1;
  expect(onPropsUpdated).toBeCalledTimes(1);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(1, { key: "count" });
  expect(getCount()).toBe(1);

  rootModel.props.count = 2;
  expect(onPropsUpdated).toBeCalledTimes(2);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(2, { key: "count" });
  expect(getCount()).toBe(2);

  rootModel.props.style.color = "blue";
  expect(onPropsUpdated).toBeCalledTimes(3);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(3, { key: "style" });
  expect(getColor()).toBe("blue");

  rootModel.props.style = { color: "red" };
  expect(onPropsUpdated).toBeCalledTimes(4);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(4, { key: "style" });
  expect(getColor()).toBe("red");

  rootModel.props.style.color = "green";
  expect(onPropsUpdated).toBeCalledTimes(5);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(5, { key: "style" });
  expect(getColor()).toBe("green");

  rootModel.props.items.push(1);
  expect(onPropsUpdated).toBeCalledTimes(6);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(6, { key: "items" });
  expect(getItems().get(0)).toBe(1);

  rootModel.props.items[0] = { id: "1" };
  expect(onPropsUpdated).toBeCalledTimes(7);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(7, { key: "items" });
  expect(getItems().get(0)).toBeInstanceOf(Y.Map);
  expect((getItems().get(0) as Y.Map<unknown>).get("id")).toBe("1");
});

test("stash and pop", () => {
  const options = createTestOptions();
  const collection = new TestWorkspace(options);
  collection.meta.initialize();

  const doc = collection.createDoc("home");
  doc.load();
  const store = doc.getStore({
    extensions,
  });

  store.addBlock("myoxus:page");

  const rootModel = store.root as RootBlockModel;

  expect(rootModel.id).toBe("0");
  expect(rootModel.flavour).toBe("myoxus:page");

  const onPropsUpdated = vi.fn();
  rootModel.propsUpdated.subscribe(onPropsUpdated);

  const getCount = () => rootModel.yBlock.get("prop:count");
  const getColor = () =>
    (rootModel.yBlock.get("prop:style") as Y.Map<string>).get("color");

  rootModel.props.count = 1;
  expect(onPropsUpdated).toBeCalledTimes(1);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(1, { key: "count" });
  expect(getCount()).toBe(1);

  rootModel.stash("count");
  rootModel.props.count = 2;
  expect(onPropsUpdated).toBeCalledTimes(3);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(3, { key: "count" });
  expect(rootModel.yBlock.get("prop:count")).toBe(1);

  rootModel.pop("count");
  expect(onPropsUpdated).toBeCalledTimes(4);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(4, { key: "count" });
  expect(rootModel.yBlock.get("prop:count")).toBe(2);

  rootModel.props.style.color = "blue";
  expect(getColor()).toBe("blue");
  expect(onPropsUpdated).toBeCalledTimes(5);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(5, { key: "style" });

  rootModel.stash("style");
  rootModel.props.style = {
    color: "red",
  };
  expect(getColor()).toBe("blue");
  expect(onPropsUpdated).toBeCalledTimes(7);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(7, { key: "style" });

  rootModel.pop("style");
  expect(getColor()).toBe("red");
  expect(onPropsUpdated).toBeCalledTimes(8);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(8, { key: "style" });

  rootModel.stash("style");
  expect(onPropsUpdated).toBeCalledTimes(9);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(9, { key: "style" });

  rootModel.props.style.color = "green";
  expect(onPropsUpdated).toBeCalledTimes(10);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(10, { key: "style" });
  expect(getColor()).toBe("red");

  rootModel.pop("style");
  expect(getColor()).toBe("green");
  expect(onPropsUpdated).toBeCalledTimes(11);
  expect(onPropsUpdated).toHaveBeenNthCalledWith(11, { key: "style" });
});

test("always get latest value in onChange", () => {
  const options = createTestOptions();
  const collection = new TestWorkspace(options);
  collection.meta.initialize();

  const doc = collection.createDoc("home");
  doc.load();
  const store = doc.getStore({
    extensions,
  });

  store.addBlock("myoxus:page");

  const rootModel = store.root as RootBlockModel;

  expect(rootModel.id).toBe("0");
  expect(rootModel.flavour).toBe("myoxus:page");

  let value: unknown;
  rootModel.propsUpdated.subscribe(({ key }) => {
    // @ts-expect-error ignore
    value = rootModel.props[key];
  });

  rootModel.props.count = 1;
  expect(value).toBe(1);

  rootModel.stash("count");

  rootModel.props.count = 2;
  expect(value).toBe(2);

  rootModel.pop("count");

  rootModel.props.count = 3;
  expect(value).toBe(3);

  rootModel.props.style.color = "blue";
  expect(value).toEqual({ color: "blue" });

  rootModel.stash("style");
  rootModel.props.style = { color: "red" };
  expect(value).toEqual({ color: "red" });
  rootModel.props.style.color = "green";
  expect(value).toEqual({ color: "green" });

  rootModel.pop("style");
  rootModel.props.style.color = "yellow";
  expect(value).toEqual({ color: "yellow" });
});

test("query", () => {
  const options = createTestOptions();
  const collection = new TestWorkspace(options);
  collection.meta.initialize();
  const doc = collection.createDoc("home");
  doc.load();
  const store1 = doc.getStore({
    extensions,
  });
  const store2 = doc.getStore({
    extensions,
  });
  const store3 = doc.getStore({
    extensions,
    query: {
      mode: "loose",
      match: [
        {
          flavour: "myoxus:list",
          viewType: "hidden",
        },
      ],
    },
  });
  const store4 = doc.getStore({
    extensions,
    query: {
      mode: "strict",
      match: [
        {
          props: { style: { color: "blue" } },
          viewType: "display",
        },
      ],
    },
  });
  expect(store1).toBe(store2);
  expect(store1).not.toBe(store3);

  const page = store1.addBlock("myoxus:page", {
    style: { border: "solid", color: "blue" },
  });
  const note = store1.addBlock("myoxus:note", {}, page);
  const paragraph1 = store1.addBlock("myoxus:paragraph", {}, note);
  const list1 = store1.addBlock("myoxus:list" as never, {}, note);

  expect(store2?.getBlock(paragraph1)?.blockViewType).toBe("display");
  expect(store2?.getBlock(list1)?.blockViewType).toBe("display");
  expect(store3?.getBlock(list1)?.blockViewType).toBe("hidden");
  expect(store4?.getBlock(page)?.blockViewType).toBe("display");
  expect(store4?.getBlock(paragraph1)?.blockViewType).toBe("hidden");

  const list2 = store1.addBlock("myoxus:list" as never, {}, note);

  expect(store2?.getBlock(list2)?.blockViewType).toBe("display");
  expect(store3?.getBlock(list2)?.blockViewType).toBe("hidden");
});

test("local readonly", () => {
  const options = createTestOptions();
  const collection = new TestWorkspace(options);
  collection.meta.initialize();
  const doc = collection.createDoc("home");
  const store1 = doc.getStore({
    extensions,
  });
  const store2 = doc.getStore({
    readonly: true,
    extensions,
  });
  const store3 = doc.getStore({ readonly: false, extensions });

  expect(store1.readonly).toBe(false);
  expect(store2.readonly).toBe(true);
  expect(store3.readonly).toBe(false);

  store1.readonly = true;

  expect(store1.readonly).toBe(true);
  expect(store2.readonly).toBe(true);
  expect(store3.readonly).toBe(false);

  store1.readonly = false;

  expect(store1.readonly).toBe(false);
  expect(store2.readonly).toBe(true);
  expect(store3.readonly).toBe(false);
});

describe("move blocks", () => {
  type Context = { doc: Store; page: BlockModel; notes: BlockModel[] };
  beforeEach((context: Context) => {
    const options = createTestOptions();
    const collection = new TestWorkspace(options);
    collection.meta.initialize();

    const doc = collection.createDoc("home");
    doc.load();
    const store = doc.getStore({ extensions });
    const pageId = store.addBlock("myoxus:page");
    const page = store.getBlock(pageId)!.model;

    const noteIds = store.addBlocks(
      [1, 2, 3].map((i) => ({
        flavour: "myoxus:note",
        blockProps: { id: `${i}` },
      })),
      page,
    );
    const notes = noteIds.map((id) => store.getBlock(id)!.model);

    context.doc = store;
    context.page = page;
    context.notes = notes;
  });

  test("move block to itself", ({ doc, page, notes }: Context) => {
    const noteIds = notes.map(({ id }) => id);

    doc.moveBlocks([notes[0]], page, notes[0], true);
    expect(page.children.map(({ id }) => id)).toEqual(noteIds);

    doc.moveBlocks([notes[0]], page, notes[0], false);
    expect(page.children.map(({ id }) => id)).toEqual(noteIds);
  });
});

test("store disposal releases document listeners and reload restores undo/redo", () => {
  const workspace = new TestWorkspace(createTestOptions());
  workspace.meta.initialize();
  const doc = workspace.createDoc("history-lifecycle");
  doc.load();
  const count = (event: "destroy" | "afterTransaction") =>
    doc.spaceDoc._observers.get(event)?.size ?? 0;
  const baseline = [count("destroy"), count("afterTransaction")];
  const store = doc.getStore({ extensions });
  try {
    for (let cycle = 0; cycle < 16; cycle++) {
      store.load();
      const manager = store.history.undoManager;
      const updates = vi.fn();
      const subscription = store.history.onUpdated.subscribe(updates);
      const text = doc.spaceDoc.getText("history-probe");
      manager.addToScope(text);
      store.transact(() => text.insert(0, "persisted 😀"));
      expect(store.canUndo).toBe(true);
      expect(manager.undoStack.at(-1)?.meta.get("selection-state")).toEqual([]);
      store.undo();
      expect(text.toString()).toBe("");
      expect(store.canRedo).toBe(true);
      store.redo();
      expect(text.toString()).toBe("persisted 😀");
      store.undo();
      expect(updates).toHaveBeenCalled();
      subscription.unsubscribe();
      store.dispose();
      expect([count("destroy"), count("afterTransaction")]).toEqual(baseline);
      expect(store.canUndo).toBe(false);
      expect(store.canRedo).toBe(false);
    }
  } finally {
    doc.dispose();
    workspace.dispose();
  }
});
