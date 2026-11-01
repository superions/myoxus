import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  resolveMermaidGfxContextMenuLabel,
  resolveMermaidGfxEdgeReconnectPointerStart,
  resolveMermaidGfxEdgeReconnectToTarget,
  resolveMermaidGfxKeyboardConnectionIntent,
  resolveMermaidGfxKeyboardEdgeReconnectIntent,
  resolveMermaidGfxKeyboardNodeConnection,
  resolveMermaidGfxKeyboardResize,
  resolveMermaidGfxKeyboardSubgraphMove,
  resolveMermaidGfxNodeConnectionPointerStart,
  resolveMermaidGfxNodeConnectionPointerUp,
  resolveMermaidGfxNodeConnectionPreview,
  resolveMermaidGfxResizePointerStart,
  resolveMermaidGfxSubgraphMovePointerStart,
  resolveMermaidVisualViewportResizeKeydown,
  resolveMermaidVisualViewportResizePointerMove,
  resolveMermaidVisualViewportResizePointerStart,
} from "../gfx-interaction.js";

describe("Mermaid GFX interaction helpers", () => {
  test("resolves connector preview target geometry without host branching", () => {
    expect(
      resolveMermaidGfxNodeConnectionPreview({
        pointer: { left: 100, top: 110 },
        sourceHandle: { left: 20, top: 30 },
        sourceNodeId: "A",
        targetHandle: {
          id: "west",
          left: 200,
          position: [0, 0.5],
          top: 210,
        },
        targetNodeId: "B",
      }),
    ).toEqual({
      source: { left: 20, top: 30 },
      target: {
        id: "west",
        left: 200,
        position: [0, 0.5],
        top: 210,
      },
      targetNodeId: "B",
      targetPortId: "west",
      targetPosition: [0, 0.5],
      validTarget: true,
    });

    expect(
      resolveMermaidGfxNodeConnectionPreview({
        pointer: { left: 100, top: 110 },
        sourceHandle: { left: 20, top: 30 },
        sourceNodeId: "A",
        targetHandle: {
          id: "west",
          left: 200,
          position: [0, 0.5],
          top: 210,
        },
        targetNodeId: "A",
      })?.target,
    ).toEqual({ left: 100, top: 110 });
  });

  test("prefers the valid preview target over the final hit target on pointer-up", () => {
    expect(
      resolveMermaidGfxNodeConnectionPointerUp({
        hitTargetNodeId: "C",
        isReadonly: false,
        preview: {
          source: { left: 20, top: 30 },
          target: { left: 200, top: 210 },
          targetNodeId: "B",
          validTarget: true,
        },
        sourceNodeId: "A",
      }),
    ).toEqual({
      sourceNodeId: "A",
      targetNodeId: "B",
    });

    expect(
      resolveMermaidGfxNodeConnectionPointerUp({
        hitTargetNodeId: "C",
        isReadonly: false,
        preview: null,
        sourceNodeId: "A",
      }),
    ).toEqual({
      sourceNodeId: "A",
      targetNodeId: "C",
    });
  });

  test("keeps node connection start and keyboard decisions in the family boundary", () => {
    expect(
      resolveMermaidGfxNodeConnectionPointerStart({
        isReadonly: false,
        selectedNodeId: "A",
      }),
    ).toEqual({ sourceNodeId: "A" });
    expect(
      resolveMermaidGfxNodeConnectionPointerStart({
        isReadonly: false,
        selectedEdgeId: "edge-1",
        selectedNodeId: "A",
      }),
    ).toBeNull();

    expect(
      resolveMermaidGfxKeyboardConnectionIntent({
        isReadonly: false,
        key: "ArrowRight",
        selectedEdgeId: "",
        selectedNodeId: "A",
        selectedSubgraphId: "",
      }),
    ).toEqual({ direction: "right", sourceNodeId: "A" });
    expect(
      resolveMermaidGfxKeyboardConnectionIntent({
        isReadonly: true,
        key: "ArrowRight",
        selectedEdgeId: "",
        selectedNodeId: "A",
        selectedSubgraphId: "",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxKeyboardNodeConnection({
        isReadonly: false,
        sourceNodeId: "A",
        targetNodeId: "B",
      }),
    ).toEqual({ sourceNodeId: "A", targetNodeId: "B" });
  });

  test("resolves edge reconnect start and keyboard direction without host branching", () => {
    const edge = {
      id: "edge-A-B",
      source: "A",
      target: "B",
    };

    expect(
      resolveMermaidGfxKeyboardEdgeReconnectIntent({
        edge,
        endpoint: "target",
        isReadonly: false,
        key: "ArrowDown",
      }),
    ).toEqual({
      direction: "down",
      edgeId: "edge-A-B",
      endpoint: "target",
      fixedNodeId: "A",
      movingNodeId: "B",
    });
    expect(
      resolveMermaidGfxKeyboardEdgeReconnectIntent({
        edge,
        endpoint: "source",
        isReadonly: true,
        key: "ArrowDown",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxEdgeReconnectPointerStart({
        edgeId: "edge-A-B",
        endpoint: "source",
        isReadonly: false,
      }),
    ).toEqual({ edgeId: "edge-A-B", endpoint: "source" });
    expect(
      resolveMermaidGfxEdgeReconnectToTarget({
        edgeId: "edge-A-B",
        endpoint: "source",
        isReadonly: false,
        targetNodeId: "C",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      endpoint: "source",
      targetNodeId: "C",
    });
  });

  test("keeps resize and viewport resize decisions out of the host", () => {
    const xywh = new Bound(10, 20, 100, 80).serialize();

    expect(
      resolveMermaidGfxKeyboardResize({
        isReadonly: false,
        key: "ArrowRight",
        kind: "node",
        nodeId: "A",
        nodeModel: { xywh },
        shiftKey: false,
        subgraphId: "",
        subgraphModel: null,
      }),
    ).toMatchObject({
      height: 80,
      target: { id: "A", kind: "node", xywh },
      width: 116,
    });
    expect(
      resolveMermaidGfxKeyboardResize({
        isReadonly: false,
        key: "ArrowDown",
        kind: "node",
        nodeId: "A",
        nodeModel: { xywh },
        shiftKey: true,
        subgraphId: "",
        subgraphModel: null,
      }),
    ).toMatchObject({ height: 128, width: 100 });
    expect(
      resolveMermaidGfxResizePointerStart({
        isReadonly: false,
        kind: "subgraph",
        nodeId: "",
        nodeModel: null,
        pointer: { x: 30, y: 40 },
        subgraphId: "SG",
        subgraphModel: { xywh },
      }),
    ).toEqual({
      start: { height: 80, width: 100, x: 30, y: 40 },
      target: { id: "SG", kind: "subgraph", xywh },
    });
    expect(
      resolveMermaidGfxKeyboardSubgraphMove({
        isReadonly: false,
        key: "ArrowRight",
        shiftKey: true,
        subgraphId: "SG",
        subgraphModel: { xywh },
      }),
    ).toMatchObject({
      target: { id: "SG", kind: "subgraph", xywh },
      x: 58,
      y: 20,
    });
    expect(
      resolveMermaidGfxSubgraphMovePointerStart({
        isReadonly: false,
        pointer: { x: 30, y: 40 },
        subgraphId: "SG",
        subgraphModel: { xywh },
      }),
    ).toEqual({
      start: { pointerX: 30, pointerY: 40, x: 10, y: 20 },
      target: { id: "SG", kind: "subgraph", xywh },
    });

    expect(
      resolveMermaidVisualViewportResizeKeydown({
        currentHeight: 320,
        isReadonly: false,
        key: "ArrowDown",
        shiftKey: true,
        step: 24,
      }),
    ).toBe(368);
    expect(
      resolveMermaidVisualViewportResizePointerStart({
        currentHeight: 320,
        isReadonly: false,
        pointerClientY: 120,
      }),
    ).toEqual({ height: 320, y: 120 });
    expect(
      resolveMermaidVisualViewportResizePointerMove({
        pointerClientY: 150,
        start: { height: 320, y: 120 },
      }),
    ).toBe(350);
  });

  test("resolves context menu copy from selected node order", () => {
    expect(
      resolveMermaidGfxContextMenuLabel({
        nodeOrder: ["A", "B"],
        nodes: [
          {
            height: 80,
            id: "A",
            label: "Start",
            shape: "rect",
            width: 140,
            x: 0,
            y: 0,
          },
          {
            height: 80,
            id: "B",
            label: "Done",
            shape: "rect",
            width: 140,
            x: 180,
            y: 0,
          },
        ],
      }),
    ).toContain("Start");
  });
});
