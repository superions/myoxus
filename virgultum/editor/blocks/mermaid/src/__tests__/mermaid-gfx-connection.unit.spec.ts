import { describe, expect, test } from "vitest";
import {
  ConnectorElementModel,
  ConnectorLabelOffsetAnchor,
  ConnectorMode,
} from "@virgultum/model";

import {
  canStartMermaidGfxEdgeReconnect,
  canStartMermaidGfxNodeConnection,
  resolveMermaidGfxConnectionResultSelection,
  resolveMermaidGfxEdgeReconnect,
  resolveMermaidGfxEdgeReconnectNodes,
  resolveMermaidGfxNodeConnection,
  resolveMermaidGfxNodeConnectionPreview,
} from "../mermaid-gfx-connection.js";

describe("Mermaid GFX node connection gates", () => {
  test("keeps a State relation label on its path outside painted object bounds", () => {
    const connector = {
      mode: ConnectorMode.Orthogonal,
      absolutePath: [
        [0, 0],
        [0, 100],
        [200, 100],
      ],
      x: 0,
      y: 0,
      w: 200,
      h: 100,
      labelObstacleIds: ["state"],
      surface: { getElementById: () => ({ xywh: "[10,50,100,50]" }) },
      getPointByOffsetDistance:
        ConnectorElementModel.prototype.getPointByOffsetDistance,
    };
    const bounds = ConnectorElementModel.prototype.getLabelXYWHOnPath.call(
      connector as never,
      40,
      20,
      { distance: 0.5, anchor: ConnectorLabelOffsetAnchor.Top },
    );
    expect(bounds).toEqual([-20, 30, 40, 20]);
    expect(connector.absolutePath).toEqual([
      [0, 0],
      [0, 100],
      [200, 100],
    ]);
  });
  test("separates a connector label from an earlier relation label on its path", () => {
    const connector = {
      labelObstacleIds: ["earlier-loop"],
      surface: {
        getElementById: () => ({
          type: "connector",
          xywh: "[0,0,0,100]",
          labelXYWH: [-20, 40, 40, 20],
        }),
      },
      getPointByOffsetDistance: (distance: number) => [0, distance * 100],
    };
    expect(
      ConnectorElementModel.prototype.getLabelXYWHOnPath.call(
        connector as never,
        40,
        20,
        { distance: 0.5, anchor: ConnectorLabelOffsetAnchor.Center },
      ),
    ).toEqual([-20, 10, 40, 20]);
  });
  test("protects the composite header without excluding the container interior", () => {
    const connector = {
      routingObstacleRegions: { composite: [0, 0, 100, 20] },
      surface: { getElementById: () => ({ xywh: "[10,40,100,200]" }) },
      getPointByOffsetDistance: (distance: number) => [60, distance * 100],
    };
    expect(
      ConnectorElementModel.prototype.getLabelXYWHOnPath.call(
        connector as never,
        40,
        20,
        { distance: 0.5, anchor: ConnectorLabelOffsetAnchor.Center },
      ),
    ).toEqual([40, 10, 40, 20]);
  });
  test("keeps loop label text off an earlier orthogonal stroke", () => {
    const connector = {
      labelObstacleIds: ["earlier"],
      surface: {
        getElementById: () => ({
          type: "connector",
          mode: ConnectorMode.Orthogonal,
          absolutePath: [
            [0, 50],
            [100, 50],
          ],
          strokeWidth: 2,
        }),
      },
      getPointByOffsetDistance: (distance: number) => [50, distance * 100],
    };
    expect(
      ConnectorElementModel.prototype.getLabelXYWHOnPath.call(
        connector as never,
        40,
        20,
        { distance: 0.5, anchor: ConnectorLabelOffsetAnchor.Center },
      ),
    ).toEqual([30, 25, 40, 20]);
  });
  test("keeps consumed orthogonal label bounds finite when preview vertices coincide", () => {
    const connector = {
      mode: ConnectorMode.Orthogonal,
      absolutePath: [
        [12, 18],
        [12, 18],
        [12, 18],
      ],
      x: 12,
      y: 18,
      w: 0,
      h: 0,
      getPointByOffsetDistance:
        ConnectorElementModel.prototype.getPointByOffsetDistance,
    };
    expect(
      ConnectorElementModel.prototype.getLabelXYWHOnPath.call(
        connector as never,
        40,
        20,
        { distance: 0.5, anchor: ConnectorLabelOffsetAnchor.Top },
      ),
    ).toEqual([-8, -12, 40, 20]);
  });

  test("starts node connection only from an editable selected source node", () => {
    expect(
      canStartMermaidGfxNodeConnection({
        isReadonly: false,
        sourceNodeId: "A",
      }),
    ).toBe(true);
    expect(
      canStartMermaidGfxNodeConnection({
        isReadonly: true,
        sourceNodeId: "A",
      }),
    ).toBe(false);
    expect(
      canStartMermaidGfxNodeConnection({
        isReadonly: false,
        sourceNodeId: "",
      }),
    ).toBe(false);
    expect(
      canStartMermaidGfxNodeConnection({
        isReadonly: false,
        selectedEdgeId: "edge-A-B",
        sourceNodeId: "A",
      }),
    ).toBe(false);
    expect(
      canStartMermaidGfxNodeConnection({
        isReadonly: false,
        selectedSubgraphId: "cluster",
        sourceNodeId: "A",
      }),
    ).toBe(false);
  });

  test("resolves directed node connection payloads and rejects self-links", () => {
    expect(
      resolveMermaidGfxNodeConnection({
        isReadonly: false,
        sourceNodeId: "A",
        targetNodeId: "B",
      }),
    ).toEqual({
      sourceNodeId: "A",
      targetNodeId: "B",
    });
    expect(
      resolveMermaidGfxNodeConnection({
        isReadonly: false,
        sourceNodeId: "A",
        targetNodeId: "A",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxNodeConnection({
        isReadonly: false,
        sourceNodeId: "",
        targetNodeId: "B",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxNodeConnection({
        isReadonly: true,
        sourceNodeId: "A",
        targetNodeId: "B",
      }),
    ).toBeNull();
  });

  test("resolves post-mutation selection for created node connections", () => {
    expect(
      resolveMermaidGfxConnectionResultSelection({
        edgeId: "edge-A-B",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      kind: "edge",
    });
    expect(
      resolveMermaidGfxConnectionResultSelection({
        edgeId: "",
      }),
    ).toEqual({
      kind: "clear-node",
    });
  });

  test("resolves drag preview lines and marks valid target nodes", () => {
    expect(
      resolveMermaidGfxNodeConnectionPreview({
        source: { left: 12, top: 18 },
        sourceNodeId: "A",
        target: { left: 96, top: 54 },
        targetNodeId: "B",
      }),
    ).toEqual({
      source: { left: 12, top: 18 },
      target: { left: 96, top: 54 },
      targetNodeId: "B",
      validTarget: true,
    });
    expect(
      resolveMermaidGfxNodeConnectionPreview({
        source: { left: 12, top: 18 },
        sourceNodeId: "A",
        target: { left: 42, top: 44 },
        targetNodeId: "A",
      }),
    ).toMatchObject({
      targetNodeId: "A",
      validTarget: false,
    });
    expect(
      resolveMermaidGfxNodeConnectionPreview({
        source: null,
        sourceNodeId: "A",
        target: { left: 42, top: 44 },
        targetNodeId: "B",
      }),
    ).toBeNull();
  });

  test("resolves edge reconnect sessions and endpoint-relative node roles", () => {
    expect(
      canStartMermaidGfxEdgeReconnect({
        edgeId: "edge-A-B",
        isReadonly: false,
      }),
    ).toBe(true);
    expect(
      canStartMermaidGfxEdgeReconnect({
        edgeId: "",
        isReadonly: false,
      }),
    ).toBe(false);
    expect(
      canStartMermaidGfxEdgeReconnect({
        edgeId: "edge-A-B",
        isReadonly: true,
      }),
    ).toBe(false);

    const edge = { id: "edge-A-B", source: "A", target: "B" };
    expect(
      resolveMermaidGfxEdgeReconnectNodes({
        edge,
        endpoint: "source",
      }),
    ).toEqual({
      fixedNodeId: "B",
      movingNodeId: "A",
    });
    expect(
      resolveMermaidGfxEdgeReconnectNodes({
        edge,
        endpoint: "target",
      }),
    ).toEqual({
      fixedNodeId: "A",
      movingNodeId: "B",
    });

    expect(
      resolveMermaidGfxEdgeReconnect({
        edgeId: "edge-A-B",
        endpoint: "target",
        isReadonly: false,
        targetNodeId: "C",
      }),
    ).toEqual({
      edgeId: "edge-A-B",
      endpoint: "target",
      targetNodeId: "C",
    });
    expect(
      resolveMermaidGfxEdgeReconnect({
        edgeId: "edge-A-B",
        endpoint: null,
        isReadonly: false,
        targetNodeId: "C",
      }),
    ).toBeNull();
    expect(
      resolveMermaidGfxEdgeReconnect({
        edgeId: "edge-A-B",
        endpoint: "target",
        isReadonly: false,
        targetNodeId: "",
      }),
    ).toBeNull();
  });
});
