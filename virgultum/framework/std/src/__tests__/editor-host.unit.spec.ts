import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from "@virgultum/store/test";
import { describe, expect, test } from "vitest";

import { TestEditorContainer } from "./test-editor.js";
import {
  type HeadingBlockModel,
  HeadingBlockSchemaExtension,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
  SurfaceBlockSchemaExtension,
} from "./test-schema.js";
import { testSpecs } from "./test-spec.js";

import "./setup.js";

const extensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  HeadingBlockSchemaExtension,
  SurfaceBlockSchemaExtension,
];

function createTestOptions() {
  const idGenerator = createAutoIncrementIdGenerator();
  return { id: "test-collection", idGenerator };
}

function wait(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

describe("editor host", () => {
  test("editor host should rerender model when view changes", async () => {
    const collection = new TestWorkspace(createTestOptions());

    collection.meta.initialize();
    const doc = collection.createDoc("home");
    const store = doc.getStore({ extensions });
    doc.load();
    const rootId = store.addBlock("test:page");
    const noteId = store.addBlock("test:note", {}, rootId);
    const headingId = store.addBlock("test:heading", { type: "h1" }, noteId);
    const headingBlock = store.getBlock(headingId)!;

    const editorContainer = new TestEditorContainer();
    editorContainer.doc = store;
    editorContainer.specs = testSpecs;

    document.body.append(editorContainer);

    await wait(50);
    let headingElm = editorContainer.std.view.getBlock(headingId);

    expect(headingElm!.tagName).toBe("TEST-H1-BLOCK");

    (headingBlock.model as HeadingBlockModel).props.type = "h2";
    await wait(50);
    headingElm = editorContainer.std.view.getBlock(headingId);

    expect(headingElm!.tagName).toBe("TEST-H2-BLOCK");
  });

  test("an embedded editor keeps the active dispatcher for its pointer gesture", async () => {
    const createEditor = (id: string) => {
      const collection = new TestWorkspace({
        id,
        idGenerator: createAutoIncrementIdGenerator(),
      });
      collection.meta.initialize();
      const doc = collection.createDoc("home");
      const store = doc.getStore({ extensions });
      doc.load();
      store.addBlock("test:page");
      const editor = new TestEditorContainer();
      editor.doc = store;
      editor.specs = testSpecs;
      return editor;
    };
    const outer = createEditor("outer-editor");
    const inner = createEditor("inner-editor");
    document.body.append(outer);
    try {
      await wait(50);
      const outerHost = outer.querySelector("editor-host");
      expect(outerHost).not.toBeNull();
      if (!outerHost) return;
      outerHost.append(inner);
      await wait(50);
      const innerHost = inner.querySelector("editor-host");
      expect(innerHost).not.toBeNull();
      if (!innerHost) return;

      innerHost.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, composed: true }),
      );

      expect(inner.std.event.active).toBe(true);
      expect(outer.std.event.active).toBe(false);

      const outerText = document.createTextNode("outer selection");
      outerHost.prepend(outerText);
      innerHost.focus();
      const range = document.createRange();
      range.selectNodeContents(outerText);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      expect(inner.std.event.active).toBe(true);
      expect(outer.std.event.active).toBe(false);
    } finally {
      outer.remove();
    }
  });
});
