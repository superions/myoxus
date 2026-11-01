import { describe, expect, test } from "vitest";

import {
  resolveMermaidGfxContextConnection,
  resolveMermaidGfxContextConnectionResult,
  resolveMermaidGfxContextMenuPosition,
  resolveMermaidGfxContextMenuSelection,
  resolveMermaidGfxContextNodeLabels,
} from "../mermaid-gfx-context-menu.js";

describe("Mermaid GFX context menu decisions", () => {
  test("selects the right-clicked node additively before opening a two-node menu", () => {
    expect(
      resolveMermaidGfxContextMenuSelection({
        explicitNodeOrder: ["A", "B"],
        nodeId: "B",
        selectedNodeId: "A",
        selectedNodeOrder: ["A"],
      }),
    ).toEqual({
      canOpenMenu: true,
      menuNodeOrder: ["A", "B"],
      selectionAction: {
        additive: true,
        nodeId: "B",
      },
    });
  });

  test("selects the right-clicked node when no visual node is selected yet", () => {
    expect(
      resolveMermaidGfxContextMenuSelection({
        explicitNodeOrder: ["A"],
        nodeId: "A",
        selectedNodeId: "",
        selectedNodeOrder: [],
      }),
    ).toEqual({
      canOpenMenu: false,
      menuNodeOrder: [],
      selectionAction: {
        additive: false,
        nodeId: "A",
      },
    });
  });

  test("opens the context menu only for exactly two explicit nodes", () => {
    expect(
      resolveMermaidGfxContextMenuSelection({
        explicitNodeOrder: ["A", "B"],
        nodeId: "",
        selectedNodeId: "B",
        selectedNodeOrder: ["A", "B"],
      }),
    ).toMatchObject({
      canOpenMenu: true,
      menuNodeOrder: ["A", "B"],
    });
    expect(
      resolveMermaidGfxContextMenuSelection({
        explicitNodeOrder: ["A", "B", "C"],
        nodeId: "C",
        selectedNodeId: "B",
        selectedNodeOrder: ["A", "B"],
      }),
    ).toMatchObject({
      canOpenMenu: false,
      menuNodeOrder: [],
    });
  });

  test("keeps context menu position inside the scoped GFX viewport", () => {
    const viewportRect = {
      height: 180,
      left: 100,
      top: 200,
      width: 320,
    };

    expect(
      resolveMermaidGfxContextMenuPosition({
        clientX: 118,
        clientY: 212,
        viewportRect,
      }),
    ).toEqual({ left: 18, top: 12 });
    expect(
      resolveMermaidGfxContextMenuPosition({
        clientX: 900,
        clientY: 900,
        viewportRect,
      }),
    ).toEqual({ left: 100, top: 132 });
    expect(
      resolveMermaidGfxContextMenuPosition({
        clientX: 10,
        clientY: 10,
        viewportRect,
      }),
    ).toEqual({ left: 8, top: 8 });
  });

  test("resolves ordered node-pair connections and rejects invalid pairs", () => {
    expect(
      resolveMermaidGfxContextConnection({
        isReadonly: false,
        nodeOrder: ["A", "B"],
      }),
    ).toEqual({
      sourceNodeId: "A",
      targetNodeId: "B",
    });
    expect(
      resolveMermaidGfxContextConnection({
        isReadonly: false,
        nodeOrder: ["A"],
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxContextConnection({
        isReadonly: false,
        nodeOrder: ["A", "A"],
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxContextConnection({
        isReadonly: true,
        nodeOrder: ["A", "B"],
      }),
    ).toBeNull();
  });

  test("resolves post-mutation context connection outcomes", () => {
    expect(
      resolveMermaidGfxContextConnectionResult({
        applied: false,
        edgeId: "edge-A-B",
        targetNodeId: "B",
      }),
    ).toEqual({
      kind: "none",
    });
    expect(
      resolveMermaidGfxContextConnectionResult({
        applied: true,
        edgeId: "edge-A-B",
        targetNodeId: "B",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      kind: "select-edge",
    });
    expect(
      resolveMermaidGfxContextConnectionResult({
        applied: true,
        edgeId: "",
        targetNodeId: "B",
      }),
    ).toEqual({
      kind: "sync-target-node",
      targetNodeId: "B",
    });
  });

  test("resolves context menu labels from the ordered source and target nodes", () => {
    expect(
      resolveMermaidGfxContextNodeLabels({
        nodeOrder: ["A", "B"],
        nodes: [
          { id: "A", label: "Start" },
          { id: "B", label: "" },
        ],
      }),
    ).toEqual({
      sourceLabel: "Start",
      targetLabel: "B",
    });
    expect(
      resolveMermaidGfxContextNodeLabels({
        nodeOrder: ["A", "missing"],
        nodes: [{ id: "A", label: "Start" }],
      }),
    ).toBeNull();
  });
});
