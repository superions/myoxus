import { describe, expect, test } from "vitest";

import {
  resolveMermaidKeyboardIntent,
  shouldReadMermaidKeyboardSelection,
} from "../mermaid-keyboard.js";

const baseInput = {
  altKey: false,
  ctrlKey: false,
  hasActiveInlineShapeTextEditor: false,
  hasEditableTarget: false,
  key: "Delete",
  metaKey: false,
  mode: "visual" as const,
  shiftKey: false,
};

describe("Mermaid keyboard intent rules", () => {
  test("protects native and inline text editing from block shortcuts", () => {
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        hasEditableTarget: true,
        hasVisualSelection: true,
      }),
    ).toBe("ignore");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        hasActiveInlineShapeTextEditor: true,
        hasVisualSelection: true,
      }),
    ).toBe("ignore");
    expect(
      shouldReadMermaidKeyboardSelection({
        ...baseInput,
        hasEditableTarget: true,
      }),
    ).toBe(false);
  });

  test("deletes family selection only for plain delete/backspace in visual mode", () => {
    expect(
      shouldReadMermaidKeyboardSelection({
        ...baseInput,
        key: "Backspace",
      }),
    ).toBe(true);
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        hasVisualSelection: true,
      }),
    ).toBe("delete-selection");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        hasVisualSelection: false,
      }),
    ).toBe("ignore");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        ctrlKey: true,
        hasVisualSelection: true,
      }),
    ).toBe("ignore");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        hasVisualSelection: true,
        mode: "source",
      }),
    ).toBe("ignore");
  });

  test("resolves undo and redo without touching visual selection", () => {
    expect(
      shouldReadMermaidKeyboardSelection({
        ...baseInput,
        ctrlKey: true,
        key: "z",
      }),
    ).toBe(false);
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        ctrlKey: true,
        hasVisualSelection: false,
        key: "z",
      }),
    ).toBe("undo");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        ctrlKey: true,
        hasVisualSelection: false,
        key: "Z",
        shiftKey: true,
      }),
    ).toBe("redo");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        hasVisualSelection: false,
        key: "y",
        metaKey: true,
      }),
    ).toBe("redo");
    expect(
      resolveMermaidKeyboardIntent({
        ...baseInput,
        altKey: true,
        ctrlKey: true,
        hasVisualSelection: false,
        key: "z",
      }),
    ).toBe("ignore");
  });
});
