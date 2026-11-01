// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { html } from "lit";
import * as Y from "yjs";
import { z } from "zod";
import type { BaseTextAttributes, DeltaInsert } from "@virgultum/store";
import { InlineEditor } from "../../inline/index.js";
import { deltaInsertsToChunks } from "../../inline/utils/delta-convert.js";
import { expandRangeEmbeds } from "../../inline/utils/embed.js";
import { transformInput } from "../../inline/utils/transform-input.js";
import "../setup.js";

type Attributes = BaseTextAttributes & { annotation?: { id: string } };
function fixture() {
  const doc = new Y.Doc();
  const text = doc.getText("text");
  text.applyDelta([
    { insert: "before " },
    { insert: "one\n", attributes: { annotation: { id: "a" } } },
    { insert: "two", attributes: { annotation: { id: "a" }, bold: true } },
    { insert: " after" },
  ]);
  const editor = new InlineEditor<Attributes>(text, {
    isEmbed: (delta) => delta.attributes?.annotation?.id ?? false,
  });
  editor.setAttributeSchema(
    z.object({
      bold: z.literal(true).optional(),
      annotation: z.object({ id: z.string() }).optional(),
    }),
  );
  return { doc, text, editor };
}

test("keyed embeds group formatting splits and body newlines without altering canonical deltas", () => {
  const { doc, text, editor } = fixture();
  try {
    expect(editor.embedDeltas.map((delta) => delta.insert)).toEqual([
      "before ",
      "one\ntwo",
      " after",
    ]);
    expect(text.toDelta()).toHaveLength(4);
    expect(
      deltaInsertsToChunks(
        editor.embedDeltas,
        (delta) => typeof editor.isEmbed(delta) === "string",
      ),
    ).toHaveLength(1);
    expect(expandRangeEmbeds(editor, { index: 9, length: 1 })).toEqual({
      index: 7,
      length: 7,
    });
    expect(expandRangeEmbeds(editor, { index: 7, length: 0 })).toEqual({
      index: 7,
      length: 0,
    });
    expect(expandRangeEmbeds(editor, { index: 10, length: 0 })).toEqual({
      index: 14,
      length: 0,
    });
    text.insert(14, "other", { annotation: { id: "b" } });
    expect(editor.embedDeltas.map((delta) => delta.insert)).toEqual([
      "before ",
      "one\ntwo",
      "other",
      " after",
    ]);
  } finally {
    doc.destroy();
  }
});

test("partial deletion is atomic, preserves adjacent text and restores the canonical body with undo", () => {
  const { doc, text, editor } = fixture();
  const history = new Y.UndoManager(text, {
    trackedOrigins: new Set([doc.clientID]),
  });
  try {
    transformInput(
      "deleteContentBackward",
      null,
      {},
      { index: 13, length: 1 },
      editor,
    );
    expect(text.toString()).toBe("before  after");
    expect(editor.getInlineRange()).toEqual({ index: 7, length: 0 });
    history.undo();
    expect(text.toString()).toBe("before one\ntwo after");
    expect(editor.embedDeltas).toHaveLength(3);
    editor.insertText({ index: 14, length: 0 }, "X");
    editor.insertText({ index: 7, length: 0 }, "Y");
    expect(
      (text.toDelta() as DeltaInsert<Attributes>[])
        .filter((delta) => !delta.attributes?.annotation)
        .map((delta) => delta.insert)
        .join(""),
    ).toBe("before YX after");
    editor.insertLineBreak({ index: 8, length: 0 });
    expect(
      (text.toDelta() as DeltaInsert<Attributes>[]).find(
        (delta) => delta.insert.includes("\n") && !delta.attributes?.annotation,
      ),
    ).toBeDefined();
  } finally {
    history.destroy();
    doc.destroy();
  }
});

test("zero-length native Delete and Backspace boundaries remove the range, not adjacent characters", () => {
  for (const [input, index] of [
    ["deleteContentForward", 7],
    ["deleteContentBackward", 14],
  ] as const) {
    const { doc, text, editor } = fixture();
    try {
      transformInput(input, null, {}, { index, length: 0 }, editor);
      expect(text.toString()).toBe("before  after");
      expect(editor.getInlineRange()).toEqual({ index: 7, length: 0 });
    } finally {
      doc.destroy();
    }
  }
});

test("real DOM ranges roundtrip both sides and the entire multiline marker, and teardown releases observers", async () => {
  const { doc, text, editor } = fixture();
  const root = document.createElement("div");
  document.body.append(root);
  editor.setAttributeRenderer(
    ({ delta }) => html`<span><v-text .str=${delta.insert}></v-text></span>`,
  );
  editor.mount(root);
  try {
    await editor.waitForUpdate();
    expect(root.querySelectorAll("v-line")).toHaveLength(1);
    expect(root.querySelectorAll('[data-v-embed="true"]')).toHaveLength(1);
    for (const range of [
      { index: 7, length: 0 },
      { index: 14, length: 0 },
      { index: 7, length: 7 },
      { index: 0, length: 20 },
    ]) {
      const native = editor.toDomRange(range);
      expect(native).not.toBeNull();
      expect(editor.toInlineRange(native!)).toEqual(range);
    }
    editor.setInlineRange({ index: 7, length: 0 });
    root.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.getInlineRange()).toEqual({ index: 14, length: 0 });
    root.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.getInlineRange()).toEqual({ index: 7, length: 0 });
    editor.setInlineRange({ index: 14, length: 6 });
    root.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.getInlineRange()).toEqual({ index: 7, length: 13 });
    editor.setReadonly(true);
    editor.deleteText({ index: 7, length: 7 });
    expect(text.toString()).toContain("one\ntwo");
    editor.unmount();
    text.insert(0, "remote ");
    expect(root.querySelectorAll("v-element")).toHaveLength(0);
  } finally {
    if (editor.mounted) editor.unmount();
    root.remove();
    doc.destroy();
  }
});
