/**
 * @vitest-environment happy-dom
 */

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { Container } from "@virgultum/editor/global/di";
import { TestWorkspace } from "@virgultum/editor/store/test";
import { describe, expect, test } from "vitest";

import { markdownToMindmap } from "../markdown.js";

const container = new Container();
getStoreManager()
  .value.get("store")
  .forEach((ext) => {
    ext.setup(container);
  });
const provider = container.provider();

describe("markdownToMindmap: convert markdown list to a mind map tree", () => {
  test("basic case", () => {
    const markdown = `
- Text A
  - Text B
    - Text C
  - Text D
    - Text E
`;
    const collection = new TestWorkspace();
    collection.meta.initialize();
    const doc = collection.createDoc().getStore();
    const nodes = markdownToMindmap(markdown, doc, provider);

    expect(nodes).toEqual({
      text: "Text A",
      children: [
        {
          text: "Text B",
          children: [
            {
              text: "Text C",
              children: [],
            },
          ],
        },
        {
          text: "Text D",
          children: [
            {
              text: "Text E",
              children: [],
            },
          ],
        },
      ],
    });
  });

  test("basic case with different indent", () => {
    const markdown = `
- Text A
    - Text B
        - Text C
    - Text D
        - Text E
`;
    const collection = new TestWorkspace();
    collection.meta.initialize();
    const doc = collection.createDoc().getStore();
    const nodes = markdownToMindmap(markdown, doc, provider);

    expect(nodes).toEqual({
      text: "Text A",
      children: [
        {
          text: "Text B",
          children: [
            {
              text: "Text C",
              children: [],
            },
          ],
        },
        {
          text: "Text D",
          children: [
            {
              text: "Text E",
              children: [],
            },
          ],
        },
      ],
    });
  });

  test("keeps complete inline labels and rejects ambiguous trees instead of dropping content", () => {
    const collection = new TestWorkspace();
    collection.meta.initialize();
    const doc = collection.createDoc().getStore();
    expect(
      markdownToMindmap(
        "- **Root** with [link](https://example.com) and `code`\n  - _Child_ tail",
        doc,
        provider,
      ),
    ).toEqual({
      text: "Root with link and code",
      children: [{ text: "Child tail", children: [] }],
    });
    expect(
      markdownToMindmap("- First\n- Lost second root", doc, provider),
    ).toBeNull();
    expect(
      markdownToMindmap("- Root\n\n  Second paragraph", doc, provider),
    ).toBeNull();
    collection.dispose();
  });

  test("empty case", () => {
    const markdown = "";
    const collection = new TestWorkspace();
    collection.meta.initialize();
    const doc = collection.createDoc().getStore();
    const nodes = markdownToMindmap(markdown, doc, provider);

    expect(nodes).toEqual(null);
  });
});
