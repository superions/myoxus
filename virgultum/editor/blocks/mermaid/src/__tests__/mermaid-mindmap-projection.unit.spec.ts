import { describe, expect, test } from "vitest";

import { parseMermaidMindmapSource } from "../engine/mindmap/index.js";
import {
  mindmapSourceTree,
  projectMindmapTree,
} from "../families/mindmap/projection/tree.js";

describe("Mermaid mindmap Source projection", () => {
  test("retains full Source bindings in the transient mindmap traversal", () => {
    const model = parseMermaidMindmapSource(
      "mindmap\n  root((Product))\n    Discovery\n      [Interview]\n    Delivery\n",
    )!;

    const tree = mindmapSourceTree(model);
    const visualModel = projectMindmapTree(model);

    expect(tree).toMatchObject({
      children: [
        {
          children: [{ children: [], source: { label: "Interview" } }],
          source: { label: "Discovery" },
        },
        {
          children: [],
          source: { label: "Delivery" },
        },
      ],
      source: {
        label: "Product",
        sourceKey: model.nodes[0].sourceKey,
        syntaxId: "root",
        runtimeId: 0,
      },
    });
    expect(visualModel.nodes.map((node) => node.id)).toEqual(
      model.nodes.map((node) => node.sourceKey),
    );
  });

  test("preserves deterministic sibling order from the Mermaid semantic model", () => {
    const model = parseMermaidMindmapSource(
      "mindmap\n  root((Root))\n    First\n    Second\n      Child\n    Third\n",
    )!;

    const tree = mindmapSourceTree(model)!;

    expect(tree.children.map((child) => child.source.label)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(
      tree.children[1].children.map((child) => child.source.label),
    ).toEqual(["Child"]);
  });
});
