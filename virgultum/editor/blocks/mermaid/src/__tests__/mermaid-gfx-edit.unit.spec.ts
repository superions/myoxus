import { describe, expect, test } from "vitest";

import {
  resolveMermaidGfxEdgeLinkTypeEdit,
  resolveMermaidGfxEdgeStyleEdit,
  resolveMermaidGfxEdgeStyleStatementEdit,
  resolveMermaidGfxNodeStyleClassEdit,
  resolveMermaidGfxSubgraphTitleEdit,
} from "../mermaid-gfx-edit.js";

describe("Mermaid GFX edit helpers", () => {
  test("resolves subgraph title edits with stable coalescing", () => {
    expect(
      resolveMermaidGfxSubgraphTitleEdit({
        subgraphId: "cluster-review",
        value: "Review",
      }),
    ).toEqual({
      coalesceKey: "flowchart-subgraph-title:cluster-review",
      subgraphId: "cluster-review",
      title: "Review",
    });
    expect(
      resolveMermaidGfxSubgraphTitleEdit({
        subgraphId: "",
        value: "Review",
      }),
    ).toBeNull();
  });

  test("resolves node semantic style edits without leaking DOM casts into the block", () => {
    expect(
      resolveMermaidGfxNodeStyleClassEdit({
        nodeId: "A",
        value: "accent",
      }),
    ).toEqual({
      nodeId: "A",
      styleClass: "accent",
    });
    expect(
      resolveMermaidGfxNodeStyleClassEdit({
        nodeId: "",
        value: "accent",
      }),
    ).toBeNull();
  });

  test("resolves edge style, link type and visual style statement edits", () => {
    expect(
      resolveMermaidGfxEdgeStyleEdit({
        edgeId: "edge-A-B",
        value: "dotted",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      style: "dotted",
    });
    expect(
      resolveMermaidGfxEdgeLinkTypeEdit({
        edgeId: "edge-A-B",
        value: "bidirectional",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      linkType: "bidirectional",
    });
    expect(
      resolveMermaidGfxEdgeStyleStatementEdit({
        edgeId: "edge-A-B",
        value: "success",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      visualStyle: "success",
    });
    expect(
      resolveMermaidGfxEdgeStyleEdit({
        edgeId: "",
        value: "solid",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxEdgeLinkTypeEdit({
        edgeId: "",
        value: "arrow",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxEdgeStyleStatementEdit({
        edgeId: "",
        value: "neutral",
      }),
    ).toBeNull();
  });
});
