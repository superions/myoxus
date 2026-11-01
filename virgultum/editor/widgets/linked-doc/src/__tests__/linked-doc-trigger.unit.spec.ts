// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { signal } from "@preact/signals-core";
import { BLOCK_ID_ATTR } from "@virgultum/std";
import { INLINE_ROOT_ATTR } from "@virgultum/std/inline";
import { describe, expect, it, vi } from "vitest";

import { MyoxusLinkedDocWidget } from "../widget.js";

// Exercise the production beforeInput handler with the range after insertion.
function input(
  text: string,
  convertTriggerKey = false,
  flavour = "myoxus:paragraph",
) {
  const inlineEditor = {
    yTextString: text,
    getInlineRange: () => ({ index: text.length, length: 0 }),
    deleteText: vi.fn(),
    insertText: vi.fn(),
    setInlineRange: vi.fn(),
    waitForUpdate: () => Promise.resolve(),
  };
  const element = document.createElement("div");
  element.setAttribute(BLOCK_ID_ATTR, "test-block");
  element.setAttribute(INLINE_ROOT_ATTR, "");
  Object.assign(element, {
    flavour,
    inlineEditor,
    model: {
      text: {
        sliceToDelta: (start: number, end: number) => [
          { insert: text.slice(start, end) },
        ],
      },
    },
  });
  const show = vi.fn();
  let handler!: (ctx: unknown) => void;
  const widget = {
    _mode$: signal("none"),
    config: {
      triggerKeys: ["@", "[[", "【【"],
      convertTriggerKey,
      ignoreSelector: "code",
      ignoreBlockTypes: ["myoxus:code"],
    },
    std: {
      host: {
        range: { value: { collapsed: true, commonAncestorContainer: element } },
      },
    },
    show,
    handleEvent: (_name: string, callback: typeof handler) => {
      handler = callback;
    },
  };
  MyoxusLinkedDocWidget.prototype["_watchInput"].call(
    widget as unknown as MyoxusLinkedDocWidget,
  );
  handler({
    get: () => ({
      event: new InputEvent("beforeinput", { data: text.slice(-1) }),
    }),
  });
  return { inlineEditor, show };
}

describe("linked document typed trigger", () => {
  it.each(["before %%literal\nsecond [["])(
    "keeps pending annotation bodies literal: %s",
    async (text) => {
      const { inlineEditor, show } = input(text, true);
      await Promise.resolve();
      expect(show).not.toHaveBeenCalled();
      expect(inlineEditor.deleteText).not.toHaveBeenCalled();
      expect(inlineEditor.insertText).not.toHaveBeenCalled();
    },
  );
  it.each(["@", "[[", "【【"])(
    "preserves %s and the adjacent text",
    async (trigger) => {
      const { inlineEditor, show } = input("prefix " + trigger);
      await Promise.resolve();
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({ primaryTriggerKey: trigger }),
      );
      expect(inlineEditor.deleteText).not.toHaveBeenCalled();
      expect(inlineEditor.insertText).not.toHaveBeenCalled();
    },
  );
  it("retains explicit conversion using the full matched trigger range", async () => {
    const { inlineEditor, show } = input("prefix [[", true);
    await Promise.resolve();
    expect(inlineEditor.deleteText).toHaveBeenCalledWith({
      index: 7,
      length: 2,
    });
    expect(inlineEditor.insertText).toHaveBeenCalledWith(
      { index: 7, length: 0 },
      "@",
    );
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTriggerKey: "@" }),
    );
  });
  it.each(["[", "prefix [[ ordinary"])("does not open for %s", async (text) => {
    const { show } = input(text);
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });
  it("does not open in a code block", async () => {
    const { show } = input("[[", false, "myoxus:code");
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });
});
