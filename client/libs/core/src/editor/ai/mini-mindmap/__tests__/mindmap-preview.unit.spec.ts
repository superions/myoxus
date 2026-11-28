/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
 * @vitest-environment happy-dom
 */

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { Container } from "@virgultum/editor/global/di";
import { TestWorkspace } from "@virgultum/editor/store/test";
import { describe, expect, test } from "vitest";

import { markdownToMindmap } from "../markdown";

const container = new Container();
for (const extension of getStoreManager().value.get("store")) {
  extension.setup(container);
}
const provider = container.provider();

function parseTree(markdown: string) {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  try {
    const store = workspace.createDoc().getStore();
    return markdownToMindmap(markdown, store, provider);
  } finally {
    workspace.dispose();
  }
}

describe("markdownToMindmap", () => {
  const expectedNestedTree = {
    text: "Text A",
    children: [
      {
        text: "Text B",
        children: [{ text: "Text C", children: [] }],
      },
      {
        text: "Text D",
        children: [{ text: "Text E", children: [] }],
      },
    ],
  };

  test("parses two-space indented markdown lists into a mindmap tree", () => {
    const markdown = [
      "- Text A",
      "  - Text B",
      "    - Text C",
      "  - Text D",
      "    - Text E",
    ].join("\n");

    expect(parseTree(markdown)).toEqual(expectedNestedTree);
  });

  test("parses four-space indented markdown lists identically", () => {
    const markdown = [
      "- Text A",
      "    - Text B",
      "        - Text C",
      "    - Text D",
      "        - Text E",
    ].join("\n");

    expect(parseTree(markdown)).toEqual(expectedNestedTree);
  });

  test("preserves inline formatting text and rejects ambiguous structures", () => {
    expect(
      parseTree(
        "- **Root** with [link](https://example.com) and `code`\n  - _Child_ tail",
      ),
    ).toEqual({
      text: "Root with link and code",
      children: [{ text: "Child tail", children: [] }],
    });
    expect(parseTree("- First\n- Lost second root")).toBeNull();
    expect(parseTree("- Root\n\n  Second paragraph")).toBeNull();
  });

  test("returns null for empty markdown input", () => {
    expect(parseTree("")).toBeNull();
  });
});
