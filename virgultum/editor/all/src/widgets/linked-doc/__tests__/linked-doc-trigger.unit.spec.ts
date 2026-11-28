// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// @vitest-environment happy-dom

import { BLOCK_ID_ATTR } from "@virgultum/core/runtime";
import { INLINE_ROOT_ATTR } from "@virgultum/core/runtime/inline";
import { describe, expect, it, vi } from "vitest";

import { handleLinkedDocBeforeInput } from "../picker-controller.js";

// Exercise the production beforeInput trigger contract with the range after insertion.
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
  handleLinkedDocBeforeInput(
    {
      isActive: () => false,
      config: {
        triggerKeys: ["@", "[[", "【【"],
        convertTriggerKey,
        ignoreSelector: "code",
        ignoreBlockTypes: ["myoxus:code"],
      },
      getRange: () =>
        ({
          collapsed: true,
          commonAncestorContainer: element,
        }) as unknown as Range,
      show,
    },
    new InputEvent("beforeinput", { data: text.slice(-1) }),
  );
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
