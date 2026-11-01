import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  mermaidGfxEdgeHandlePoints,
  mermaidGfxEdgeHandleViewPoints,
  mermaidGfxNodeHandlePoints,
  mermaidGfxNodeHandleViewPoints,
  mermaidGfxSubgraphMoveHandleRect,
  mermaidGfxSubgraphMoveHandleViewRect,
  mermaidGfxSubgraphResizeHandlePoint,
  mermaidGfxSubgraphResizeHandleViewPoint,
} from "../mermaid-gfx-handles.js";

describe("Mermaid GFX handle geometry", () => {
  test("places node connect and resize handles on the right edge", () => {
    expect(
      mermaidGfxNodeHandlePoints({
        xywh: new Bound(10, 20, 120, 80).serialize(),
      }),
    ).toEqual({
      connectPorts: [{ id: "connect", position: [1, 0.5], x: 130, y: 60 }],
      resize: { x: 130, y: 100 },
    });
  });

  test("places State/Sequence node connect handles outside label boxes", () => {
    expect(
      mermaidGfxNodeHandlePoints({
        denseLabelNode: true,
        xywh: new Bound(10, 20, 120, 80).serialize(),
      }),
    ).toEqual({
      connectPorts: [{ id: "connect", position: [1, 0.5], x: 148, y: 60 }],
      resize: { x: 130, y: 100 },
    });
    expect(
      mermaidGfxNodeHandlePoints({
        diagramType: "stateDiagram-v2",
        xywh: new Bound(10, 20, 120, 80).serialize(),
      }),
    ).toMatchObject({ connectPorts: [{ x: 148, y: 60 }] });
  });

  test("places subgraph resize handle at the lower right corner", () => {
    expect(
      mermaidGfxSubgraphResizeHandlePoint(
        new Bound(-40, 50, 240, 160).serialize(),
      ),
    ).toEqual({ x: 200, y: 210 });
  });

  test("places the subgraph move hit area across the group header", () => {
    expect(
      mermaidGfxSubgraphMoveHandleRect(
        new Bound(-40, 50, 240, 160).serialize(),
      ),
    ).toEqual({ height: 35.2, width: 224, x: -32, y: 50 });
  });

  test("places edge reconnect handles at source and target centers", () => {
    expect(
      mermaidGfxEdgeHandlePoints({
        sourceXywh: new Bound(0, 0, 100, 60).serialize(),
        targetXywh: new Bound(300, 120, 80, 100).serialize(),
      }),
    ).toEqual({
      source: { x: 50, y: 30 },
      target: { x: 340, y: 170 },
    });
  });

  test("places dense-label reconnect handles above content boxes", () => {
    expect(
      mermaidGfxEdgeHandlePoints({
        diagramType: "sequenceDiagram",
        sourceXywh: new Bound(0, 0, 100, 60).serialize(),
        targetXywh: new Bound(300, 120, 80, 100).serialize(),
      }),
    ).toEqual({
      source: { x: 50, y: -18 },
      target: { x: 340, y: 102 },
    });
    expect(
      mermaidGfxEdgeHandlePoints({
        diagramType: "erDiagram",
        sourceXywh: new Bound(40, 90, 160, 118).serialize(),
        targetXywh: new Bound(320, 90, 160, 118).serialize(),
      }),
    ).toEqual({
      source: { x: 120, y: 72 },
      target: { x: 400, y: 72 },
    });
  });

  test("places reconnect handles on semantic endpoint positions when supplied", () => {
    expect(
      mermaidGfxEdgeHandlePoints({
        sourcePosition: [0.5, 1],
        sourceXywh: new Bound(20, 30, 140, 80).serialize(),
        targetPosition: [0.5, 0],
        targetXywh: new Bound(40, 190, 120, 70).serialize(),
      }),
    ).toEqual({
      source: { x: 90, y: 110 },
      target: { x: 100, y: 190 },
    });
  });

  test("projects node, subgraph and edge handles into view coordinates", () => {
    const toViewPoint = (x: number, y: number) => ({
      left: x + 7,
      top: y + 11,
    });

    expect(
      mermaidGfxNodeHandleViewPoints({
        diagramType: "flowchart",
        toViewPoint,
        xywh: new Bound(10, 20, 120, 80).serialize(),
      }),
    ).toEqual({
      connectPorts: [
        {
          id: "connect",
          left: 137,
          position: [1, 0.5],
          top: 71,
        },
      ],
      resize: { left: 137, top: 111 },
    });
    expect(
      mermaidGfxSubgraphResizeHandleViewPoint({
        toViewPoint,
        xywh: new Bound(-40, 50, 240, 160).serialize(),
      }),
    ).toEqual({ left: 207, top: 221 });
    expect(
      mermaidGfxSubgraphMoveHandleViewRect({
        toViewPoint,
        xywh: new Bound(-40, 50, 240, 160).serialize(),
      }),
    ).toEqual({ height: 35.2, left: -25, top: 61, width: 224 });
    expect(
      mermaidGfxEdgeHandleViewPoints({
        sourceXywh: new Bound(0, 0, 100, 60).serialize(),
        targetXywh: new Bound(300, 120, 80, 100).serialize(),
        toViewPoint,
      }),
    ).toEqual({
      source: { left: 57, top: 41 },
      target: { left: 347, top: 181 },
    });
  });

  test("does not return partial handle sets when projection is incomplete", () => {
    expect(
      mermaidGfxNodeHandleViewPoints({
        diagramType: "sequenceDiagram",
        toViewPoint: (x) => (x > 100 ? null : { left: x, top: 1 }),
        xywh: new Bound(10, 20, 120, 80).serialize(),
      }),
    ).toBeNull();
    expect(
      mermaidGfxEdgeHandleViewPoints({
        sourceXywh: new Bound(0, 0, 100, 60).serialize(),
        targetXywh: new Bound(300, 120, 80, 100).serialize(),
        toViewPoint: (x, y) => (x > 200 ? null : { left: x, top: y }),
      }),
    ).toBeNull();
  });
});
