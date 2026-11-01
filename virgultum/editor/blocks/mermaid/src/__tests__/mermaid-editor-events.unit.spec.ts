import { describe, expect, test } from "vitest";

import {
  findMermaidEditableEventTarget,
  hasActiveMermaidInlineTextEditor,
  shouldPreventMermaidEditableFocusDefault,
  shouldRefocusMermaidEditableTarget,
} from "../mermaid-editor-events.js";

function eventWithPath(path: readonly EventTarget[]) {
  const event = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", {
    configurable: true,
    value: path[0] ?? null,
  });
  Object.defineProperty(event, "composedPath", {
    configurable: true,
    value: () => [...path],
  });
  return event;
}

describe("Mermaid editor event targets", () => {
  test("finds direct native input targets", () => {
    const input = document.createElement("input");
    const select = document.createElement("select");
    const textarea = document.createElement("textarea");

    expect(findMermaidEditableEventTarget(eventWithPath([input]))).toBe(input);
    expect(findMermaidEditableEventTarget(eventWithPath([select]))).toBe(
      select,
    );
    expect(findMermaidEditableEventTarget(eventWithPath([textarea]))).toBe(
      textarea,
    );
  });

  test("finds inline GFX shape text editors through composed paths", () => {
    const editor = document.createElement("edgeless-shape-text-editor");
    const richText = document.createElement("rich-text");
    const span = document.createElement("span");
    richText.append(span);
    editor.append(richText);

    expect(
      findMermaidEditableEventTarget(eventWithPath([span, richText, editor])),
    ).toBe(richText);
  });

  test("finds inline GFX connector label editors through composed paths", () => {
    const editor = document.createElement("edgeless-connector-label-editor");
    const richText = document.createElement("rich-text");
    const span = document.createElement("span");
    richText.append(span);
    editor.append(richText);

    expect(
      findMermaidEditableEventTarget(eventWithPath([span, richText, editor])),
    ).toBe(richText);
  });

  test("gates source reconciliation for native and Mermaid inline text editors", () => {
    expect(hasActiveMermaidInlineTextEditor()).toBe(false);
    const editor = document.createElement("edgeless-shape-text-editor");
    document.body.append(editor);
    try {
      expect(hasActiveMermaidInlineTextEditor()).toBe(true);
    } finally {
      editor.remove();
    }

    const mermaidEditor = document.createElement("input");
    mermaidEditor.className = "myoxus-mermaid-inline-node-editor";
    document.body.append(mermaidEditor);
    try {
      expect(hasActiveMermaidInlineTextEditor()).toBe(true);
    } finally {
      mermaidEditor.remove();
    }
  });

  test("keeps non-editable canvas targets out of editor gates", () => {
    const canvasTarget = document.createElement("div");
    canvasTarget.className = "myoxus-mermaid-gfx-node";

    expect(findMermaidEditableEventTarget(eventWithPath([canvasTarget]))).toBe(
      null,
    );
  });

  test("resolves refocus and prevent-default policy for pointer focus repair", () => {
    const input = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const select = document.createElement("select");

    expect(
      shouldRefocusMermaidEditableTarget({
        eventType: "pointerdown",
        target: input,
      }),
    ).toBe(true);
    expect(
      shouldRefocusMermaidEditableTarget({
        eventType: "keydown",
        target: input,
      }),
    ).toBe(false);
    expect(
      shouldRefocusMermaidEditableTarget({
        eventType: "pointerdown",
        target: checkbox,
      }),
    ).toBe(false);
    expect(
      shouldPreventMermaidEditableFocusDefault({
        isCancelable: true,
        target: input,
      }),
    ).toBe(true);
    expect(
      shouldPreventMermaidEditableFocusDefault({
        isCancelable: true,
        target: select,
      }),
    ).toBe(false);
    expect(
      shouldPreventMermaidEditableFocusDefault({
        isCancelable: true,
        target: checkbox,
      }),
    ).toBe(false);
    expect(
      shouldPreventMermaidEditableFocusDefault({
        isCancelable: false,
        target: input,
      }),
    ).toBe(false);
  });
});
