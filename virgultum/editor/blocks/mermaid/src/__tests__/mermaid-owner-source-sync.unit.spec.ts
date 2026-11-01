import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test, vi } from "vitest";

import {
  canScheduleMermaidOwnerSourceSync,
  createMermaidProjectionOwnerSourceSyncKey,
  isExpectedMermaidOwnerCandidate,
  isMermaidOwnerAdoptionCandidate,
  MERMAID_OWNER_SOURCE_DRIFT_DELAY_MS,
  MERMAID_OWNER_SOURCE_SYNC_DELAY_MS,
  MERMAID_OWNER_SOURCE_SYNC_PAUSE_MS,
  MermaidOwnerSourceSyncController,
  nextMermaidOwnerSourceSyncPauseUntil,
  projectTypeOwnedAdoptedMermaidOwnerShape,
  restoreExpectedMermaidOwnerChildrenFromActiveGfx,
  shouldScheduleMermaidOwnerSourceSync,
  shouldSyncKnownMermaidOwnerDrift,
} from "../mermaid-owner-source-sync.js";

function createYMap(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
    values,
  };
}

describe("Mermaid owner source sync key", () => {
  test("serializes frame identity, Mermaid metadata, visual props and missing children", () => {
    const elements = new Map<string, unknown>([
      [
        "shape-1",
        {
          id: "shape-1",
          props: {
            mermaidNodeLabel: "Label from props",
            mermaidNodeShape: "rect",
            shapeType: "rect",
            type: "shape",
            xywh: "[1,2,3,4]",
          },
          shapeType: "rounded",
          text: { toString: () => "Visible text" },
          type: "shape",
          yMap: createYMap({
            mermaidNodeFamilyData: JSON.stringify({
              family: "architecture",
              payload: { icon: "server", kind: "service" },
              version: 1,
            }),
            mermaidNodeId: "A",
            mermaidNodeDisplayLabel: "Label from yMap\nDetail",
            mermaidNodeLabel: "Label from yMap",
            mermaidNodeDenseLabel: true,
            mermaidNodeSelectable: false,
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
      ],
      [
        "subgraph-1",
        {
          id: "subgraph-1",
          text: "Cluster",
          type: "shape",
          xywh: "[8,9,10,11]",
          yMap: createYMap({
            mermaidRole: "mermaid-flowchart-subgraph",
            mermaidSubgraphFamilyData: JSON.stringify({
              family: "architecture",
              payload: { icon: "cloud" },
              version: 1,
            }),
            mermaidSubgraphId: "cluster",
            mermaidSubgraphTitle: "Cluster",
          }),
        },
      ],
      [
        "edge-1",
        {
          xywh: "[40,50,220,80]",
          props: {
            source: { id: "shape-1", position: [0.5, 0.25] },
            target: { id: "shape-2", position: [0.5, 0.75] },
            type: "connector",
          },
          strokeStyle: "dash",
          text: "Edge label",
          yMap: createYMap({
            mermaidEdgeConnectorMode: "straight",
            mermaidEdgeFamilyData: JSON.stringify({
              family: "architecture",
              payload: { fromPort: "R", toPort: "L" },
              version: 1,
            }),
            mermaidEdgeId: "edge-A-B",
            mermaidEdgeLabelPlacement: "top",
            mermaidEdgeStyle: "dotted",
            mermaidRole: "mermaid-flowchart-edge",
          }),
        },
      ],
    ]);
    const frame = {
      childIds: ["shape-1", "subgraph-1", "edge-1", "missing-child"],
      id: "frame-1",
      surface: {
        getElementById: (id: string) => elements.get(id),
      },
      xywh: "[0,0,640,480]",
    };
    const sequenceOwner = {
      props: { diagramType: "sequenceDiagram" },
    } as never;
    const key = createMermaidProjectionOwnerSourceSyncKey(sequenceOwner, {
      childElementIds: frame.childIds,
      displayOnly: false,
      getElementById: (id: string) => (elements.get(id) ?? null) as never,
      kind: "direct",
      owner: sequenceOwner,
      ownerId: frame.id,
      ownerXYWH: frame.xywh as never,
      surfaceId: "surface-1",
    });

    expect(key).toContain("frame-1|4");
    expect(key).not.toContain("[0,0,640,480]");
    expect(key).toContain("shape-1;shape-1;shape;[1,2,3,4]");
    expect(key).toContain("Visible text");
    expect(key).toContain("mermaidNodeId=A");
    expect(key).toContain('mermaidNodeFamilyData={"family":"architecture"');
    expect(key).toContain('"icon":"server"');
    expect(key).toContain("mermaidNodeDisplayLabel=Label from yMap\nDetail");
    expect(key).toContain("mermaidNodeLabel=Label from yMap");
    expect(key).toContain("mermaidNodeDenseLabel=true");
    expect(key).toContain("mermaidNodeSelectable=false");
    expect(key).not.toContain("Label from props");
    expect(key).toContain("shapeType=rounded");
    expect(key).toContain("edge-1;;connector;;shape-1;shape-2;Edge label");
    expect(key).not.toContain("@0.5,0.25");
    expect(key).not.toContain("[40,50,220,80]");
    expect(key).toContain("subgraph-1;subgraph-1;shape;[8,9,10,11]");
    expect(key).toContain(
      'mermaidSubgraphFamilyData={"family":"architecture","payload":{"icon":"cloud"},"version":1}',
    );
    expect(key).toContain("mermaidSubgraphId=cluster");
    expect(key).toContain("mermaidEdgeConnectorMode=straight");
    expect(key).toContain("mermaidEdgeId=edge-A-B");
    expect(key).toContain(
      'mermaidEdgeFamilyData={"family":"architecture","payload":{"fromPort":"R","toPort":"L"},"version":1}',
    );
    expect(key).toContain("mermaidEdgeLabelPlacement=top");
    expect(key).toContain("strokeStyle=dash");
    expect(key).toContain("missing-child:missing");

    const stateOwner = {
      props: { diagramType: "stateDiagram-v2" },
    } as never;
    const stateKey = createMermaidProjectionOwnerSourceSyncKey(stateOwner, {
      childElementIds: frame.childIds,
      displayOnly: false,
      getElementById: (id: string) => (elements.get(id) ?? null) as never,
      kind: "direct",
      owner: stateOwner,
      ownerId: frame.id,
      ownerXYWH: frame.xywh as never,
      surfaceId: "surface-1",
    });
    expect(stateKey).toContain("edge-1;;connector;;shape-1;shape-2;Edge label");
    expect(stateKey).not.toContain("@0.5,0.25");
  });

  test("matches expected owner restore candidates through shared Mermaid metadata", () => {
    const expected = {
      details: new Set(["A::detail::member-1"]),
      edges: new Set(["edge-A-B"]),
      nodes: new Set(["A"]),
      subgraphs: new Set(["cluster"]),
    };

    expect(
      isExpectedMermaidOwnerCandidate(
        {
          props: {
            mermaidNodeId: "wrong",
            mermaidRole: "mermaid-flowchart-node",
          },
          yMap: createYMap({
            mermaidNodeId: "A",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isExpectedMermaidOwnerCandidate(
        {
          yMap: createYMap({
            mermaidEdgeId: "edge-A-B",
            mermaidRole: "mermaid-flowchart-edge",
          }),
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isExpectedMermaidOwnerCandidate(
        {
          yMap: createYMap({
            mermaidRole: "mermaid-flowchart-subgraph",
            mermaidSubgraphId: "cluster",
          }),
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isExpectedMermaidOwnerCandidate(
        {
          yMap: createYMap({
            mermaidDetailId: "member-1",
            mermaidDetailOwnerNodeId: "A",
            mermaidRole: "mermaid-relationship-detail",
          }),
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isExpectedMermaidOwnerCandidate(
        {
          yMap: createYMap({
            mermaidNodeId: "foreign",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isExpectedMermaidOwnerCandidate(
        {
          yMap: createYMap({
            mermaidNodeId: "A",
            mermaidRole: "foreign-role",
          }),
        },
        expected,
      ),
    ).toBe(false);
  });

  test("restores missing expected active GFX children into the owner projection", () => {
    const added: unknown[][] = [];
    const frame = {
      addChildren: (models: unknown[]) => added.push(models),
      childIds: ["node-existing"],
      id: "frame-1",
      xywh: new Bound(0, 0, 400, 240).serialize(),
    };
    const missingNode = {
      id: "shape-A",
      yMap: createYMap({
        mermaidNodeId: "A",
        mermaidRole: "mermaid-flowchart-node",
      }),
    };
    const missingEdge = {
      id: "edge-A-B",
      yMap: createYMap({
        mermaidEdgeId: "edge-A-B",
        mermaidRole: "mermaid-flowchart-edge",
      }),
    };
    const missingSubgraph = {
      id: "cluster-1",
      yMap: createYMap({
        mermaidRole: "mermaid-flowchart-subgraph",
        mermaidSubgraphId: "cluster",
      }),
    };
    const missingDetail = {
      id: "detail-A-member",
      yMap: createYMap({
        mermaidDetailId: "class-member-A-1",
        mermaidDetailOwnerNodeId: "A",
        mermaidRole: "mermaid-relationship-detail",
      }),
    };
    const restored = restoreExpectedMermaidOwnerChildrenFromActiveGfx({
      candidates: [
        {
          id: "node-existing",
          yMap: createYMap({
            mermaidNodeId: "B",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
        missingNode,
        missingEdge,
        missingSubgraph,
        missingDetail,
        {
          id: "foreign",
          yMap: createYMap({
            mermaidNodeId: "foreign",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
      ],
      projectionOwner: frame as never,
      visualModel: {
        diagramType: "flowchart",
        direction: "TD",
        edges: [
          {
            id: "edge-A-B",
            label: "",
            source: "A",
            style: "solid",
            target: "B",
          },
        ],
        nodes: [
          {
            details: [
              {
                id: "class-member-A-1",
                kind: "field",
                label: "+title",
                order: 0,
                sourceKey: "member",
              },
            ],
            height: 80,
            id: "A",
            label: "A",
            shape: "rect",
            width: 160,
            x: 0,
            y: 0,
          },
          {
            height: 80,
            id: "B",
            label: "B",
            shape: "rect",
            width: 160,
            x: 220,
            y: 0,
          },
        ],
        subgraphs: [
          {
            height: 180,
            id: "cluster",
            nodeIds: ["A", "B"],
            title: "Cluster",
            width: 360,
            x: 0,
            y: 0,
          },
        ],
        version: 1,
      },
    });

    expect(restored).toEqual([
      "shape-A",
      "edge-A-B",
      "cluster-1",
      "detail-A-member",
    ]);
    expect(added).toEqual([
      [missingNode, missingEdge, missingSubgraph, missingDetail],
    ]);
  });

  test("projects adopted shapes through the resolved owner", () => {
    const ownerXywh = new Bound(0, 0, 400, 240).serialize();
    expect(
      isMermaidOwnerAdoptionCandidate(
        {
          type: "shape",
          xywh: new Bound(20, 20, 120, 60).serialize(),
          yMap: createYMap(),
        },
        ownerXywh,
      ),
    ).toBe(true);
    expect(
      isMermaidOwnerAdoptionCandidate(
        {
          type: "shape",
          xywh: new Bound(900, 900, 120, 60).serialize(),
          yMap: createYMap(),
        },
        ownerXywh,
      ),
    ).toBe(false);

    const yMap = createYMap();
    const model = {
      id: "shape-1",
      radius: 8,
      shapeType: "rect",
      text: undefined,
      type: "shape",
      xywh: new Bound(0, 0, 40, 24).serialize(),
      yMap,
    };
    const ownerBound = new Bound(0, 0, 400, 240);
    const visualModel = {
      diagramType: "flowchart" as const,
      direction: "TD" as const,
      edges: [],
      nodes: [],
      styleStatements: [],
      subgraphs: [],
      version: 1 as const,
    };
    const updates = projectTypeOwnedAdoptedMermaidOwnerShape(model, {
      ownerBound: ownerBound,
      visualModel,
    });

    expect(updates?.mermaidRole).toBe("mermaid-flowchart-node");
    expect(updates?.mermaidNodeId).toBe("N1");
    expect(updates?.mermaidNodeShape).toBe("rounded");
    expect(updates?.xywh).toBe(model.xywh);
  });

  test("does not rewrite known Sequence helper shapes with intentional empty labels", () => {
    const writes: Array<[string, unknown]> = [];
    const yMap = createYMap({
      mermaidFlowchartVisualStyleVersion: "gfx-flowchart-v1",
      mermaidNodeDisplayLabel: "",
      mermaidNodeId: "message-User-API-1-source",
      mermaidNodeLabel: "",
      mermaidNodeSelectable: false,
      mermaidNodeShape: "circle",
      mermaidRole: "mermaid-flowchart-node",
    });
    const originalSet = yMap.set;
    yMap.set = (key: string, value: unknown) => {
      writes.push([key, value]);
      originalSet(key, value);
    };

    const updates = projectTypeOwnedAdoptedMermaidOwnerShape(
      {
        id: "shape-message-anchor",
        shapeType: "ellipse",
        text: "",
        type: "shape",
        xywh: new Bound(96, 148, 12, 12).serialize(),
        yMap,
      },
      {
        ownerBound: new Bound(0, 0, 400, 240),
        visualModel: {
          diagramType: "sequenceDiagram",
          direction: "TD",
          edges: [],
          nodes: [],
          styleStatements: [],
          subgraphs: [],
          version: 1,
        },
      },
    );

    expect(updates).toBeNull();
    expect(writes).toEqual([]);
  });

  test("keeps resized known Mermaid owner nodes out of adoption size normalization", () => {
    const yMap = createYMap({
      mermaidNodeId: "A",
      mermaidRole: "mermaid-flowchart-node",
    });
    const model = {
      id: "shape-A",
      text: "Start",
      type: "shape",
      xywh: new Bound(120, 80, 340, 220).serialize(),
      yMap,
    };

    const updates = projectTypeOwnedAdoptedMermaidOwnerShape(model, {
      ownerBound: new Bound(0, 0, 400, 240),
      visualModel: {
        diagramType: "flowchart",
        direction: "TD",
        edges: [],
        nodes: [],
        styleStatements: [],
        subgraphs: [],
        version: 1,
      },
    });

    expect(updates).toBeNull();
    expect(model.xywh).toBe(new Bound(120, 80, 340, 220).serialize());
    expect(yMap.get("mermaidNodeId")).toBe("A");
  });

  test("gates owner source sync scheduling before timers are created", () => {
    const allowed = {
      isReadonly: false,
      now: 500,
      pausedUntil: 400,
    };

    expect(canScheduleMermaidOwnerSourceSync(allowed)).toBe(true);
    expect(
      canScheduleMermaidOwnerSourceSync({
        ...allowed,
        isReadonly: true,
      }),
    ).toBe(false);
    expect(
      canScheduleMermaidOwnerSourceSync({
        ...allowed,
        now: 300,
      }),
    ).toBe(false);
  });

  test("gates known owner drift by key and visual hash differences", () => {
    const unchanged = {
      currentKey: "projectionOwner:key",
      ownerHash: "visual:hash",
      isReadonly: false,
      nextKey: "projectionOwner:key",
      now: 500,
      pausedUntil: 400,
      storedHash: "visual:hash",
    };

    expect(shouldSyncKnownMermaidOwnerDrift(unchanged)).toBe(false);
    expect(
      shouldSyncKnownMermaidOwnerDrift({
        ...unchanged,
        nextKey: "projectionOwner:key:changed",
      }),
    ).toBe(true);
    expect(
      shouldSyncKnownMermaidOwnerDrift({
        ...unchanged,
        ownerHash: "visual:hash:changed",
      }),
    ).toBe(true);
    expect(
      shouldSyncKnownMermaidOwnerDrift({
        ...unchanged,
        isReadonly: true,
        nextKey: "projectionOwner:key:changed",
      }),
    ).toBe(false);
    expect(
      shouldSyncKnownMermaidOwnerDrift({
        ...unchanged,
        nextKey: "",
      }),
    ).toBe(false);
    expect(
      shouldSyncKnownMermaidOwnerDrift({
        ...unchanged,
        nextKey: "projectionOwner:key:changed",
        now: 300,
      }),
    ).toBe(false);
  });

  test("schedules visual owner source sync for real key drift", () => {
    const changed = {
      currentKey: "projectionOwner:key",
      inEdgeless: false,
      isReadonly: false,
      mode: "visual" as const,
      nextKey: "projectionOwner:key:changed",
      now: 500,
      pausedUntil: 400,
    };

    expect(shouldScheduleMermaidOwnerSourceSync(changed)).toBe(true);
    expect(
      shouldScheduleMermaidOwnerSourceSync({
        ...changed,
        nextKey: "projectionOwner:key",
      }),
    ).toBe(false);
    expect(
      shouldScheduleMermaidOwnerSourceSync({
        ...changed,
        nextKey: "",
      }),
    ).toBe(false);
    expect(
      shouldScheduleMermaidOwnerSourceSync({
        ...changed,
        mode: "source",
      }),
    ).toBe(false);
    expect(
      shouldScheduleMermaidOwnerSourceSync({
        ...changed,
        inEdgeless: true,
      }),
    ).toBe(true);
    expect(
      shouldScheduleMermaidOwnerSourceSync({
        ...changed,
        isReadonly: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleMermaidOwnerSourceSync({
        ...changed,
        now: 300,
      }),
    ).toBe(false);
  });

  test("keeps owner source-sync timer values in the source-sync contract", () => {
    expect(MERMAID_OWNER_SOURCE_SYNC_DELAY_MS).toBe(80);
    expect(MERMAID_OWNER_SOURCE_DRIFT_DELAY_MS).toBe(0);
    expect(MERMAID_OWNER_SOURCE_SYNC_PAUSE_MS).toBe(300);
    expect(nextMermaidOwnerSourceSyncPauseUntil(1200)).toBe(1500);
  });

  test("owns owner source-sync timer, key and pause state outside the block host", () => {
    vi.useFakeTimers();
    try {
      const controller = new MermaidOwnerSourceSyncController();
      let syncCount = 0;
      const syncNow = () => {
        syncCount += 1;
      };

      expect(
        controller.schedule({
          isReadonly: false,
          now: 500,
          syncNow,
        }),
      ).toBe(true);
      vi.advanceTimersByTime(79);
      expect(syncCount).toBe(0);
      vi.advanceTimersByTime(1);
      expect(syncCount).toBe(1);

      controller.acceptKey("projectionOwner:key");
      expect(controller.currentKey).toBe("projectionOwner:key");
      controller.pause(1000);
      expect(controller.pausedUntil).toBe(1300);
      expect(
        controller.schedule({
          isReadonly: false,
          now: 1100,
          syncNow,
        }),
      ).toBe(false);

      expect(
        controller.scheduleIfDrifted({
          inEdgeless: true,
          isReadonly: false,
          mode: "visual",
          nextKey: "projectionOwner:key:next",
          now: 1400,
          syncNow,
        }),
      ).toBe(true);
      expect(controller.currentKey).toBe("projectionOwner:key:next");
      vi.advanceTimersByTime(80);
      expect(syncCount).toBe(2);

      expect(
        controller.syncKnownDriftBeforeEnsure({
          ownerHash: "projectionOwner:hash",
          isReadonly: false,
          nextKey: "projectionOwner:key:drifted",
          now: 1500,
          storedHash: "stored:hash",
          syncNow,
        }),
      ).toBe(true);
      expect(controller.currentKey).toBe("projectionOwner:key:drifted");
      vi.advanceTimersByTime(0);
      expect(syncCount).toBe(3);

      controller.clearPause();
      expect(controller.pausedUntil).toBe(0);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
