import {
  editMindmapNode,
  moveMindmapSubtree,
  addMindmapNode,
  deleteMindmapSubtree,
} from "../engine/mindmap/index.js";
import {
  resolveMermaidGitGraphSource,
  editGitGraphCommit,
  addGitGraphCommit,
  createGitGraphCheckout,
  editGitGraphConfig,
  editGitGraphCherryPick,
  moveGitGraphStatements,
} from "../engine/gitgraph/index.js";

import { c4ProjectionSelectionId } from "../families/c4/gfx-data.js";
import { addBlock, addBlockConnection } from "../engine/block/index.js";
import { mermaidSequenceFamily } from "../families/sequence/family.js";
import { sequenceGfxHooks } from "../families/sequence/runtime.js";
import {
  editSequenceActivation,
  editSequenceMessage,
  reorderSequenceMessage,
  deleteSequenceMessage,
} from "../engine/sequence/index.js";
import {
  addClass,
  editClass,
  editClassMember,
  editClassDiagramTitle,
  connectClasses,
  addClassNamespace,
} from "../engine/class/index.js";
import { classRelationProjection } from "../families/class/edge-projection.js";
import { applyKanbanCommands } from "../engine/kanban/commands.js";
import {
  applyTimelineCommand,
  type TimelineCommand,
} from "../engine/timeline/commands.js";
import { parseTimelineSource } from "../engine/timeline/parser.js";

describe("Timeline source commands", () => {
  const apply = (
    model: ReturnType<typeof parseTimelineSource>,
    command: TimelineCommand,
  ) => {
    const result = applyTimelineCommand(model, command, {
      baseSource: model.sourceDocument.source,
      readonly: false,
    });
    expect(result.reason).toBe("applied");
    expect(result.changed).toBe(true);
    return result;
  };
  test("retain CRLF, inline sibling identities, comments and empty periods", () => {
    const source =
      "timeline TD\r\n  title Roadmap\r\n\r\n  P : A : B\r\n    : C\r\n  Q\r\n";
    const model = parseTimelineSource(source);
    const [a, b, c] = model.events;
    const renamed = apply(model, {
      type: "rename",
      anchor: { kind: "event", id: b.id },
      label: "Renamed",
    });
    expect(renamed.source).toBe(source.replace(": B", ": Renamed"));
    expect(renamed.model.events.map((item) => item.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    const inserted = apply(renamed.model, {
      type: "event-add",
      label: "Before",
      targetPeriodId: model.periods[0].id,
      targetOrder: 0,
    });
    expect(inserted.model.events.slice(1).map((item) => item.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    const commented = apply(inserted.model, {
      type: "comment-add",
      anchor: { kind: "event", id: b.id },
      text: "Keep this",
    });
    expect(commented.model.comments[0].anchor).toEqual({
      kind: "event",
      id: b.id,
    });
    expect(
      commented.model.events
        .filter((item) => item.periodId === model.periods[0].id)
        .map((item) => item.label),
    ).toEqual(["Before", "A", "Renamed", "C"]);
    const moved = apply(commented.model, {
      type: "event-move",
      id: b.id,
      targetPeriodId: model.periods[1].id,
      targetOrder: 0,
    });
    expect(moved.model.events.find((item) => item.id === b.id)?.periodId).toBe(
      model.periods[1].id,
    );
    expect(
      moved.model.events
        .filter((item) => item.periodId === model.periods[0].id)
        .map((item) => item.id),
    ).toEqual([inserted.selection!.id, a.id, c.id]);
    expect(moved.model.comments[0].anchor.id).toBe(b.id);
    expect(
      applyTimelineCommand(
        moved.model,
        { type: "delete", anchor: { kind: "event", id: b.id } },
        { baseSource: moved.source, readonly: false },
      ).changed,
    ).toBe(false);
    const deleted = apply(moved.model, {
      type: "delete",
      anchor: { kind: "event", id: b.id },
      strategy: { kind: "cascade" },
    });
    expect(
      deleted.model.periods.find((item) => item.id === model.periods[1].id)
        ?.label,
    ).toBe("Q");
    expect(deleted.model.comments).toEqual([]);
    expect(deleted.source.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });
});
import { parseSankeySource } from "../engine/charts/sankey/parser.js";
import { applyMermaidSankeyFamilySourceCommand } from "../families/charts/sankey/source-application.js";
import { applyTreemapCommand } from "../engine/charts/treemap/commands/index.js";
import { parseTreemapSource } from "../engine/charts/treemap/parser.js";
import {
  Bound,
  ConnectorLabelOffsetAnchor,
  ConnectorMode,
  MERMAID_FLOWCHART_SUBGRAPH_ROLE,
  MERMAID_GFX_DETAIL_ROLE,
  addMermaidArchitectureEdge,
  addMermaidBlockDiagramEdge,
  addMermaidC4Relationship,
  addErRelationship,
  addMermaidRequirementRelation,
  addMermaidSequenceMessage,
  addStateTransition,
  addMermaidVisualNode,
  addMermaidVisualSubgraph,
  architectureEdgeFamilyData,
  architectureEdgeGfxData,
  architectureNodeFamilyData,
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
  architectureSubgraphGfxData,
  connectMermaidVisualNodes,
  createMermaidVisualFamilyData,
  createMermaidVisualModelFromGfxElements,
  describe,
  expect,
  expectMermaidVisualModel,
  generateMermaidArchitectureSource,
  generateMermaidBlockDiagramSource,
  generateMermaidC4Source,
  generateMermaidJourneySource,
  applyKanbanCommand,
  generateMermaidMindmapSource,
  generateMermaidRequirementSource,
  generateMermaidSequenceSource,
  generateMermaidSourceFromGfxVisualModel,
  generateMermaidSourceFromVisualModel,
  getMermaidGfxShapePalette,
  getMermaidVisualFrameGeometry,
  getMermaidVisualElementOriginFromAnchor,
  getMermaidVisualNodeDetailElementEntries,
  installProjectedMermaidTestTheme,
  moveMermaidJourneyStepToSection,
  moveMermaidVisualNode,
  parseMermaidArchitectureSource,
  parseMermaidBlockDiagramSource,
  parseMermaidC4Source,
  parseMermaidClassSource,
  parseMermaidErSource,
  applyGanttCommand,
  parseMermaidGanttSource,
  parseMermaidGitGraphSource,
  parseMermaidJourneySource,
  parseMermaidKanbanSource,
  parseMermaidMindmapSource,
  applyPacketCommand,
  parseMermaidPacketSource,
  parseMermaidPieSource,
  parseMermaidRequirementSource,
  parseMermaidSequenceSource,
  parseMermaidSourceToGfxVisualModel,
  parseMermaidSourceToVisualModel,
  parseMermaidStateSource,
  parseMermaidTimelineSource,
  parseMermaidVisualFamilyData,
  renameMermaidArchitectureEdge,
  renameMermaidArchitectureService,
  renameMermaidBlockDiagramEdge,
  renameMermaidBlockDiagramNode,
  renameMermaidC4Element,
  renameMermaidC4Relationship,
  editErRelationship,
  renameMermaidJourneySection,
  renameMermaidJourneyStep,
  renameMermaidMindmapNode,
  renameMermaidRequirementRelation,
  renameMermaidSequenceMessage,
  renameMermaidSequenceParticipant,
  setStateHeading,
  editStateTransition,
  renameMermaidVisualSubgraph,
  renderVisualEditorForSource,
  resizeMermaidVisualSubgraph,
  serializeMermaidVisualFamilyData,
  resolveMermaidFamilyRuntime,
  resolveMermaidGfxEdgeEndpointPositions,
  setMermaidJourneyStepActors,
  setMermaidJourneyStepScore,
  setMermaidMindmapNodeShape,
  setMermaidRequirementRisk,
  setMermaidVisualEdgeC4Relationship,
  setMermaidVisualEdgeRequirementRelationKind,
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeStyleClass,
  setMermaidVisualSubgraphDirection,
  test,
  toMermaidConnectorElementProps,
  toMermaidNodeDetailElementProps,
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
  typeOwnedMermaidNodeDetailElementProjection,
  yMapFromRecord,
} from "./mermaid-test-support.js";
import { applyMermaidPieSourceCommand } from "../engine/charts/pie/writer.js";
import {
  sequenceObjectFamilyData as sequenceEdgeFamilyData,
  sequenceNodeBinding as sequenceNodeGfxData,
  sequenceFamilyPayload as sequenceSubgraphGfxData,
} from "../families/sequence/gfx-data.js";
import { addState } from "../engine/state/index.js";
import { stateModelToVisual } from "../families/state/visual-model.js";
import {
  classEdgeGfxData,
  classNodeGfxData,
} from "../families/class/gfx-data.js";
import { erEdgeFamilyData, erEdgeGfxData } from "../families/er/gfx-data.js";
import { readErProjectionModel } from "../families/er/source-application.js";
import { erModelToVisual } from "../families/er/visual-model.js";
import {
  addErEntity,
  editErAttribute,
  reconnectErRelationship,
  reorderErAttribute,
} from "../engine/er/index.js";
import {
  c4BoundaryGfxData,
  c4EdgeFamilyData,
  c4NodeFamilyData,
  c4NodeGfxData,
} from "../families/c4/object-data.js";
import {
  gitGraphBinding,
  readGitGraphProjectionModel,
} from "../families/gitgraph/gfx-data.js";
import { createGitGraphMerge } from "../engine/gitgraph/commands/merge-commands.js";
import { gitGraphModelToVisual } from "../families/gitgraph/visual-model.js";
import type { MermaidVisualNode } from "../families/runtime/gfx-model.js";
import { mermaidVisualFamilyPayload } from "../families/runtime/gfx-family-data.js";
import { readMindmapProjectionModel } from "../families/mindmap/source-application.js";
import { requirementEdgeFamilyData } from "../families/requirement/gfx-data.js";

describe("Mermaid engine and family contracts", () => {
  test("persists only the exact versioned JSON-safe family-data envelope", () => {
    const familyData = createMermaidVisualFamilyData("contract-test", {
      enabled: true,
      nested: { count: 2, labels: ["one", "two"] },
    });
    const serialized = serializeMermaidVisualFamilyData(familyData);

    expect(JSON.parse(serialized)).toEqual({
      family: "contract-test",
      payload: {
        enabled: true,
        nested: { count: 2, labels: ["one", "two"] },
      },
      version: 1,
    });
    expect(parseMermaidVisualFamilyData(serialized)).toEqual(familyData);
    expect(
      parseMermaidVisualFamilyData(
        JSON.stringify({ family: "contract-test", enabled: true }),
      ),
    ).toBeUndefined();
    expect(
      parseMermaidVisualFamilyData(
        JSON.stringify({
          extra: true,
          family: "contract-test",
          payload: {},
          version: 1,
        }),
      ),
    ).toBeUndefined();
    expect(() =>
      createMermaidVisualFamilyData("contract-test", { value: Number.NaN }),
    ).toThrow("JSON-safe");
  });

  test("keeps negative family layout extents inside their owner projection", () => {
    const model = parseMermaidSourceToGfxVisualModel(
      [
        "flowchart TD",
        "  A([Start])",
        "  B{Check}",
        "  C[Prepare]",
        "  D[(Store)]",
        "  E[/Input/]",
        "  F[[Subroutine]]",
        "  G((Review))",
        "  H{{Gate}}",
        "  I[\\Manual\\]",
        "  J([Done])",
      ].join("\n"),
    ).model!;
    const negativeModel = {
      ...model,
      nodes: model.nodes.map((node) => ({
        ...node,
        x: node.x - 500,
        y: node.y - 120,
      })),
    };
    const minX = Math.min(...negativeModel.nodes.map((node) => node.x));
    const minY = Math.min(...negativeModel.nodes.map((node) => node.y));
    const fallback = new Bound(578, 240, 420, 260);
    const geometry = getMermaidVisualFrameGeometry(negativeModel, fallback);

    expect(Math.min(minX, minY)).toBeLessThan(0);
    expect(geometry.offsetX).toBe(Math.max(0, -minX));
    expect(geometry.offsetY).toBe(Math.max(0, -minY));
    expect(geometry.bound.x).toBe(fallback.x + Math.min(0, minX));
    expect(geometry.bound.y).toBe(fallback.y + Math.min(0, minY));
    expect(geometry.bound.x + geometry.offsetX).toBe(fallback.x);
    expect(geometry.bound.y + geometry.offsetY).toBe(fallback.y);
    const anchorNode = negativeModel.nodes[0];
    const anchorBound = new Bound(
      fallback.x + anchorNode.x,
      fallback.y + anchorNode.y,
      anchorNode.width,
      anchorNode.height,
    );
    const recoveredOrigin = getMermaidVisualElementOriginFromAnchor(
      anchorNode,
      anchorBound,
      geometry.bound,
    );
    expect(
      getMermaidVisualFrameGeometry(
        negativeModel,
        recoveredOrigin,
      ).bound.serialize(),
    ).toBe(geometry.bound.serialize());
    for (const node of negativeModel.nodes) {
      expect(node.x + geometry.offsetX).toBeGreaterThanOrEqual(0);
      expect(node.y + geometry.offsetY).toBeGreaterThanOrEqual(0);
      expect(node.x + geometry.offsetX + node.width).toBeLessThanOrEqual(
        geometry.bound.w - 80,
      );
      expect(node.y + geometry.offsetY + node.height).toBeLessThanOrEqual(
        geometry.bound.h - 80,
      );
    }
  });

  test("parses editable flowcharts and regenerates deterministic source", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart LR\n  A[Start] -->|go| B{Result}\n",
    );

    expect(parsed.model).toBeTruthy();
    expect(parsed.visualModelHash).toMatch(/^fnv1a:/);
    expect(parsed.model?.direction).toBe("LR");
    expect(parsed.model?.nodes.map((node) => node.id)).toEqual(["A", "B"]);
    expect(parsed.model?.edges[0]).toMatchObject({
      label: "go",
      source: "A",
      target: "B",
    });
    expect(generateMermaidSourceFromVisualModel(parsed.model!)).toContain(
      "A[Start] --> |go| B{Result}",
    );
  });

  test("keeps flowchart-elk diagrams on the visual flowchart canvas without losing the ELK header", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart-elk LR\n  A[Start] --> B[Result]\n",
    );

    expect(parsed.diagramType).toBe("flowchart-elk");
    expect(parsed.model?.diagramType).toBe("flowchart-elk");
    expect(generateMermaidSourceFromVisualModel(parsed.model!)).toContain(
      "flowchart-elk LR",
    );
  });

  test("preserves graph alias, non-default directions and supported flowchart shape syntax", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "graph RL",
        "  A((Circle)) -.->|check| B[(Database)]",
        "  C[[Subroutine]]",
        "  D{{Hexagon}}",
        "  E([Stadium])",
      ].join("\n"),
    );

    expect(parsed.model).toBeTruthy();
    expect(parsed.model).toMatchObject({
      direction: "RL",
      familyData: createMermaidVisualFamilyData("flowchart", {
        syntax: "graph",
      }),
    });
    expect(parsed.model?.nodes.map((node) => [node.id, node.shape])).toEqual([
      ["A", "circle"],
      ["B", "database"],
      ["C", "subroutine"],
      ["D", "hexagon"],
      ["E", "stadium"],
    ]);
    const source = generateMermaidSourceFromVisualModel(parsed.model!);
    expect(source).toContain("graph RL");
    expect(source).toContain("A((Circle)) -.-> |check| B[(Database)]");
    expect(source).toContain("C[[Subroutine]]");
    expect(source).toContain("D{{Hexagon}}");
    expect(source).toContain("E([Stadium])");
  });

  test("wraps disconnected top-down flowchart nodes into a compact editable grid", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        "  A([Start])",
        "  B{Check}",
        "  C[Prepare]",
        "  D[(Store)]",
        "  E[/Input/]",
        "  F[[Subroutine]]",
        "  G((Review))",
        "  H{{Gate}}",
        "  I[\\Manual\\]",
        "  J([Done])",
      ].join("\n"),
    );

    const nodes = parsed.model?.nodes ?? [];
    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const rowYs = new Set(nodes.map((node) => node.y));

    expect(nodes).toHaveLength(10);
    expect(rowYs.size).toBeGreaterThan(1);
    expect(maxX - minX).toBeLessThanOrEqual(820);
  });

  test("roundtrips flowchart subgraphs as editable visual groups without dropping membership", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        '  subgraph SG ["Review lane"]',
        "    direction LR",
        "    A[Draft] -->|approve| B[Publish]",
        "  end",
        "  B --x C[Archive]",
      ].join("\n"),
    );

    expect(parsed.model).toBeTruthy();
    expect(parsed.model?.subgraphs).toHaveLength(1);
    expect(parsed.model?.subgraphs?.[0]).toMatchObject({
      direction: "LR",
      id: "SG",
      nodeIds: ["A", "B"],
      title: "Review lane",
    });

    const source = generateMermaidSourceFromVisualModel(parsed.model!);
    expect(source).toContain('subgraph SG ["Review lane"]');
    expect(source).toContain("direction LR");
    expect(source).toContain("A[Draft] --> |approve| B[Publish]");
    expect(source).toContain("B --x C[Archive]");
  });

  test("roundtrips flowchart edges to and from subgraphs without creating phantom nodes", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        '  subgraph SG ["Review lane"]',
        "    A[Draft]",
        "  end",
        "  SG --> B[Done]",
        "  B --> SG",
      ].join("\n"),
    );

    expect(parsed.model).toBeTruthy();
    expect(parsed.model?.nodes.map((node) => node.id)).toEqual(["A", "B"]);
    expect(parsed.model?.subgraphs?.map((subgraph) => subgraph.id)).toEqual([
      "SG",
    ]);
    expect(parsed.model?.edges).toMatchObject([
      { source: "SG", target: "B" },
      { source: "B", target: "SG" },
    ]);

    const source = generateMermaidSourceFromVisualModel(parsed.model!);
    expect(source).toContain('subgraph SG ["Review lane"]');
    expect(source).toContain("SG --> B[Done]");
    expect(source).toContain("B --> SG");

    const connector = toMermaidConnectorElementProps(
      parsed.model!.edges[0],
      new Map([
        ["SG", "subgraph-element"],
        ["B", "node-b-element"],
      ]),
    );
    expect(connector).toMatchObject({
      labelOffset: {
        anchor: ConnectorLabelOffsetAnchor.Center,
        distance: 0.5,
      },
      mermaidEdgeLabelPlacement: "",
      mode: ConnectorMode.Orthogonal,
      source: { id: "subgraph-element" },
      target: { id: "node-b-element" },
    });
  });

  test("parses compact subgraph headers but emits Mermaid-compatible spaced headers", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        "  subgraph SG[Review lane]",
        "    A[Draft]",
        "  end",
      ].join("\n"),
    );

    expect(parsed.model?.subgraphs?.[0]).toMatchObject({
      id: "SG",
      nodeIds: ["A"],
      title: "Review lane",
    });
    expect(generateMermaidSourceFromVisualModel(parsed.model!)).toContain(
      'subgraph SG ["Review lane"]',
    );
  });

  test("separates cyclic complex flowchart subgraph lanes before computing bounds", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        "  subgraph Intake [Checkout intake]",
        "    Start([Customer starts checkout]) --> Cart{Cart ready?}",
        "    Cart --> Session[Create checkout session]",
        "  end",
        "  subgraph PaymentLane [Payment and fulfillment]",
        "    Session --> Payment[Collect payment]",
        "    Payment --> PaymentValid{Payment valid?}",
        "    PaymentValid -->|No| RetryPayment[Ask for another payment method]",
        "    RetryPayment --> Payment",
        "    PaymentValid -->|Yes| Auth[(Authorize payment)]",
        "  end",
        "  subgraph Closeout [Closeout]",
        "    Auth --> Confirmation[Send confirmation]",
        "    Confirmation --> Success([Order completed])",
        "  end",
      ].join("\n"),
    );

    expect(parsed.model).toBeTruthy();
    const subgraphs = parsed.model!.subgraphs!;
    expect(subgraphs.map((subgraph) => subgraph.id)).toEqual([
      "Intake",
      "PaymentLane",
      "Closeout",
    ]);
    for (const [index, subgraph] of subgraphs.entries()) {
      const next = subgraphs[index + 1];
      if (!next) continue;
      expect(next.y).toBeGreaterThan(subgraph.y + subgraph.height + 80);
    }
    const start = parsed.model!.nodes.find((node) => node.id === "Start")!;
    const payment = parsed.model!.nodes.find((node) => node.id === "Payment")!;
    expect(payment.y).toBeGreaterThan(start.y + start.height + 240);
  });

  test("reads flowchart subgraph membership back from GFX geometry", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  subgraph SG[Lane]\n    A[Draft]\n  end\n  B[Outside]\n",
    );
    const model = parsed.model!;
    const ownerBound = new Bound(100, 100, 500, 420);
    const subgraphProps = toMermaidSubgraphElementProps(
      {
        ...model.subgraphs![0],
        height: 220,
        nodeIds: [],
        width: 280,
        x: 0,
        y: 0,
      },
      ownerBound,
    );
    const nodeAProps = toMermaidShapeElementProps(
      { ...model.nodes[0], x: 60, y: 70 },
      ownerBound,
    );
    const nodeBProps = toMermaidShapeElementProps(
      { ...model.nodes[1], x: 340, y: 260 },
      ownerBound,
    );

    const synced = createMermaidVisualModelFromGfxElements({
      diagramType: "flowchart",
      direction: "TD",
      elements: [
        {
          id: "subgraph",
          type: "shape",
          xywh: subgraphProps.xywh,
          yMap: {
            get: (key) =>
              ({
                mermaidRole: MERMAID_FLOWCHART_SUBGRAPH_ROLE,
                mermaidSubgraphId: "SG",
                mermaidSubgraphTitle: "Lane",
              })[key],
          },
        },
        {
          id: "node-a",
          text: "Draft",
          type: "shape",
          xywh: nodeAProps.xywh,
          yMap: {
            get: (key) =>
              ({
                mermaidNodeId: "A",
                mermaidRole: "mermaid-flowchart-node",
              })[key],
          },
        },
        {
          id: "node-b",
          text: "Outside",
          type: "shape",
          xywh: nodeBProps.xywh,
          yMap: {
            get: (key) =>
              ({
                mermaidNodeId: "B",
                mermaidRole: "mermaid-flowchart-node",
              })[key],
          },
        },
      ],
      ownerBound,
      previousModel: model,
    });

    expect(synced?.subgraphs?.[0]?.nodeIds).toEqual(["A"]);
  });

  test("roundtrips hierarchy subgraph metadata from GFX props", () => {
    const ownerBound = new Bound(100, 100, 720, 420);
    const architectureModel = parseMermaidSourceToGfxVisualModel(
      "architecture-beta\n  group web(icon)[Web]\n  service app(server)[App] in web\n",
    ).model!;
    const architectureSubgraphProps = toMermaidSubgraphElementProps(
      {
        ...architectureModel.subgraphs![0],
        familyData: architectureSubgraphFamilyData({
          ...architectureSubgraphGfxData(architectureModel.subgraphs![0])!,
          icon: "cloud",
        }),
      },
      ownerBound,
    );
    const architectureNodeProps = toMermaidShapeElementProps(
      architectureModel.nodes[0],
      ownerBound,
    );
    const architectureRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "architecture",
      direction: "TD",
      elements: [
        {
          id: "architecture-group",
          type: "shape",
          xywh: architectureSubgraphProps.xywh,
          yMap: yMapFromRecord(architectureSubgraphProps),
        },
        {
          id: "architecture-service",
          props: architectureNodeProps,
          text: architectureNodeProps.text as string,
          type: "shape",
          xywh: architectureNodeProps.xywh,
          yMap: yMapFromRecord(architectureNodeProps),
        },
      ],
      ownerBound,
      previousModel: architectureModel,
    });

    expect(architectureRoundtrip?.subgraphs?.[0]).toMatchObject({
      id: "web",
      title: expect.stringContaining("Web"),
    });

    const c4Model = parseMermaidSourceToGfxVisualModel(
      [
        "C4Container",
        '  Container_Boundary(frontend, "Frontend") {',
        '    Container(app, "App")',
        "  }",
      ].join("\n"),
    ).model!;
    const c4SubgraphProps = toMermaidSubgraphElementProps(
      c4Model.subgraphs![0],
      ownerBound,
    );
    const c4NodeProps = toMermaidShapeElementProps(
      c4Model.nodes[0],
      ownerBound,
    );
    const c4Roundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "c4",
      direction: "TD",
      elements: [
        {
          id: "c4-boundary",
          type: "shape",
          xywh: c4SubgraphProps.xywh,
          yMap: yMapFromRecord(c4SubgraphProps),
        },
        {
          id: "c4-app",
          props: c4NodeProps,
          text: c4NodeProps.text as string,
          type: "shape",
          xywh: c4NodeProps.xywh,
          yMap: yMapFromRecord(c4NodeProps),
        },
      ],
      ownerBound,
      previousModel: c4Model,
    });

    expect(c4Roundtrip?.subgraphs?.[0]).toMatchObject({
      id: c4Model.subgraphs![0].id,
      title: "Frontend",
    });
    expect(c4BoundaryGfxData(c4Roundtrip!.subgraphs![0])).toMatchObject({
      boundaryKind: "Container_Boundary",
    });
  });

  test("does not silently change explicit flowchart groups when nodes move", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        "  subgraph SG[Lane]",
        "    A[Inside]",
        "  end",
        "  B[Outside]",
      ].join("\n"),
    );
    const model = parsed.model!;
    const outside = model.nodes.find((node) => node.id === "B")!;
    const subgraph = model.subgraphs![0];
    const moved = moveMermaidVisualNode(
      model,
      outside.id,
      subgraph.x + (subgraph.width - outside.width) / 2 - outside.x,
      subgraph.y + (subgraph.height - outside.height) / 2 - outside.y,
    );

    expect(moved.subgraphs?.[0]?.nodeIds).toEqual(["A"]);
    const source = generateMermaidSourceFromVisualModel(moved);
    expect(source.indexOf("B[Outside]")).toBeGreaterThan(
      source.indexOf("  end"),
    );
  });

  test("moves flowchart nodes left past the frame origin instead of clamping", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start]\n  B[Result]\n",
    );
    const model = parsed.model!;
    const result = model.nodes.find((node) => node.id === "B")!;
    const moved = moveMermaidVisualNode(model, result.id, -result.x - 80, 0);

    expect(moved.nodes.find((node) => node.id === "B")?.x).toBe(-80);
    expect(generateMermaidSourceFromVisualModel(moved)).toContain("B[Result]");
  });

  test("keeps flowchart edge IDs and style statements on the visual path", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart LR",
        "  A[Start] e_review@--> B[Review]",
        "  classDef active fill:#eef2ff,stroke:#4f46e5,color:#111827;",
        "  class A,B active;",
        "  style B fill:#ecfdf5,stroke:#059669;",
        "  linkStyle 0 stroke:#4f46e5,stroke-width:2px;",
      ].join("\n"),
    );

    expect(parsed.model).toBeTruthy();
    expect(parsed.model?.edges[0]).toMatchObject({
      id: "e_review",
      mermaidId: "e_review",
      source: "A",
      target: "B",
    });
    expect(parsed.model?.styleStatements).toEqual([
      "classDef active fill:#eef2ff,stroke:#4f46e5,color:#111827;",
      "class A,B active;",
      "style B fill:#ecfdf5,stroke:#059669;",
      "linkStyle 0 stroke:#4f46e5,stroke-width:2px;",
    ]);
    const source = generateMermaidSourceFromVisualModel(parsed.model!);
    expect(source).toContain("A[Start] e_review@--> B[Review]");
    expect(source).toContain(
      "classDef active fill:#eef2ff,stroke:#4f46e5,color:#111827;",
    );
    expect(source).toContain("linkStyle 0 stroke:#4f46e5,stroke-width:2px;");
  });

  test("edits flowchart subgraph controls and style palettes through semantic commands", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start]\n  B[Done]\n",
    );
    const withGroup = addMermaidVisualSubgraph(parsed.model!, ["A", "B"]);
    const subgraphId = withGroup.subgraphs![0].id;
    const renamed = renameMermaidVisualSubgraph(
      withGroup,
      subgraphId,
      "Reviewed lane",
    );
    const directed = setMermaidVisualSubgraphDirection(
      renamed,
      subgraphId,
      "LR",
    );
    const resized = resizeMermaidVisualSubgraph(directed, subgraphId, 320, 220);
    const styledNode = setMermaidVisualNodeStyleClass(resized, "A", "accent");
    const connected = connectMermaidVisualNodes(styledNode, "A", "B");
    const edgeId = connected.edges[0].id;
    const styledEdge = setMermaidVisualEdgeStyleStatement(
      connected,
      edgeId,
      "success",
    );

    expect(styledEdge.subgraphs?.[0]).toMatchObject({
      direction: "LR",
      height: 220,
      id: subgraphId,
      nodeIds: ["A", "B"],
      title: "Reviewed lane",
      width: 320,
    });
    expect(styledEdge.styleStatements).toEqual(
      expect.arrayContaining([
        "classDef accent fill:rgb(245, 245, 245),stroke:rgb(70, 90, 210),color:rgb(20, 20, 20);",
        "class A accent;",
        "linkStyle 0 stroke:rgb(30, 130, 70),stroke-width:2px;",
      ]),
    );
    const source = generateMermaidSourceFromVisualModel(styledEdge);
    expect(source).toContain(`subgraph ${subgraphId} ["Reviewed lane"]`);
    expect(source).toContain("direction LR");
    expect(source).toContain("class A accent;");
    expect(source).toContain(
      "linkStyle 0 stroke:rgb(30, 130, 70),stroke-width:2px;",
    );
  });

  test("keeps Architecture source syntax and relationship metadata in its FamilyData owner", () => {
    installProjectedMermaidTestTheme();
    const architectureSource =
      'architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[Database] in api\n  web:R -["reads"]- L:db\n';
    const architectureModel =
      parseMermaidSourceToGfxVisualModel(architectureSource).model!;
    architectureModel.nodes[1] = {
      ...architectureModel.nodes[1],
      label: "Database",
      x: architectureModel.nodes[1].x + 50,
    };
    architectureModel.edges[0] = {
      ...architectureModel.edges[0],
      familyData: architectureEdgeFamilyData({
        ...architectureEdgeGfxData(architectureModel.edges[0]),
        fromPort: "B",
        toPort: "T",
      }),
      label: "queries",
      sourcePosition: [0.5, 1],
      targetPosition: [0.5, 0],
    };
    const architectureNext = generateMermaidSourceFromGfxVisualModel(
      architectureSource,
      architectureModel,
    );
    expect(architectureNext).toContain("architecture-beta");
    expect(architectureNext).toContain("service db(database)[Database] in api");
    expect(architectureNext).toContain('web:B -["queries"]- T:db');
    expect(architectureNext).not.toMatch(/^flowchart\b/m);
  });

  test("keeps other graph-family source syntax and relationship metadata when syncing shared GFX edits", () => {
    const c4Source =
      'C4Context\n  Person(user, "User", "Uses docs")\n  System(app, "Myoxus", "Workspace", "Rust")\n  Rel(user, app, "Uses", "HTTPS")\n';
    const c4Model = parseMermaidSourceToGfxVisualModel(c4Source).model!;
    const c4AppNode = c4Model.nodes.find(
      (node) => node.id === c4ProjectionSelectionId(c4Model, "element", "app"),
    )!;
    c4AppNode.familyData = c4NodeFamilyData({
      ...c4NodeGfxData(c4AppNode)!,
      effectiveTechnology: "Postgres",
      kind: "ContainerDb",
      sourceTechnology: "Postgres",
    });
    c4AppNode.shape = "database";
    const c4Relationship = setMermaidVisualEdgeC4Relationship(
      c4Model,
      c4Model.edges[0].id,
      "BiRel",
      "GraphQL",
    );
    c4Relationship.edges[0].label = "Synchronizes";
    const c4Next = generateMermaidSourceFromGfxVisualModel(
      c4Source,
      c4Relationship,
    );
    expect(c4Next).toContain("C4Context");
    expect(c4Next).toContain(
      'ContainerDb(app, "Myoxus", "Postgres", "Workspace", "Rust")',
    );
    expect(c4Next).toContain('BiRel(user, app, "Synchronizes", "GraphQL")');
    expect(c4Next).not.toMatch(/^flowchart\b/m);

    const classSource =
      "classDiagram\n  class User {\n    +id\n  }\n  class Order\n  User <|-- Order : owns\n";
    const classModel = parseMermaidSourceToGfxVisualModel(classSource).model!;
    classModel.nodes[1] = {
      ...classModel.nodes[1],
      label: "Purchase",
      x: classModel.nodes[1].x + 40,
    };
    classModel.edges[0] = {
      ...classModel.edges[0],
      label: "creates",
      source: classModel.nodes[1].id,
      target: classModel.nodes[0].id,
    };
    const classNext = generateMermaidSourceFromGfxVisualModel(
      classSource,
      classModel,
    );
    expect(classNext).toContain("classDiagram");
    expect(classNext).toContain("class User {");
    expect(classNext).toContain('class Order["Purchase"]');
    expect(classNext).toContain("Order <|-- User : creates");
    expect(classNext).not.toMatch(/^flowchart\b/m);

    const erSource =
      "erDiagram\n  CUSTOMER {\n    string name PK\n  }\n  ORDER {\n    string id PK\n  }\n  CUSTOMER ||--o{ ORDER : places\n";
    const erModel = parseMermaidSourceToGfxVisualModel(erSource).model!;
    erModel.edges[0] = {
      ...erModel.edges[0],
      label: "creates",
      source: erModel.nodes[1].id,
      target: erModel.nodes[0].id,
    };
    const erNext = generateMermaidSourceFromGfxVisualModel(erSource, erModel);
    expect(erNext).toBe(
      erSource.replace(
        "CUSTOMER ||--o{ ORDER : places",
        "ORDER ||--o{ CUSTOMER : creates",
      ),
    );

    const ganttSource =
      "gantt\n  title Release\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :done, design, 2026-01-01, 2d\n  Ship :active, ship, 2026-01-04, 1d\n";
    const ganttModel = parseMermaidGanttSource(ganttSource)!;
    const ship = ganttModel.tasks.find((task) => task.id === "ship")!;
    const renamed = applyGanttCommand({
      command: { label: "Deploy", taskId: ship.recordId, type: "task.rename" },
      model: ganttModel,
      readonly: false,
    });
    expect(renamed.changed).toBe(true);
    const linked = applyGanttCommand({
      command: {
        kind: "after",
        newReferenceId: "design",
        referenceId: "ship",
        taskRecordId: renamed.model.tasks.find((task) => task.id === "design")!
          .recordId,
        type: "dependency.reconnect",
      },
      model: renamed.model,
      readonly: false,
    });
    const ganttNext = (linked.changed ? linked : renamed).source;
    expect(ganttNext).toContain("gantt");
    expect(ganttNext).toContain("Deploy");
    expect(ganttNext).not.toMatch(/^flowchart\b/m);

    const gitGraphSource =
      'gitGraph\n  commit id:"A"\n  branch feature\n  checkout feature\n  commit id:"B"\n';
    const gitGraphModel =
      parseMermaidSourceToGfxVisualModel(gitGraphSource).model!;
    const featureCommit = gitGraphModel.nodes.find(
      (node) => node.label === "B" && gitGraphBinding(node)?.role === "commit",
    )!;
    featureCommit.label = "Feature ready";
    gitGraphModel.edges.push({
      id: "free-merge",
      label: "",
      linkType: "arrow",
      source: featureCommit.id,
      target: gitGraphModel.nodes[0]!.id,
      style: "solid",
    });
    expect(
      generateMermaidSourceFromGfxVisualModel(gitGraphSource, gitGraphModel),
    ).toBe(gitGraphSource);

    const mindmapSource =
      "mindmap\n  root((Product))\n    Discovery\n      [Interview]\n    Delivery\n";
    const mindmapModel =
      parseMermaidSourceToGfxVisualModel(mindmapSource).model!;
    const interviewNode = mindmapModel.nodes.find(
      (node) => node.label === "Interview",
    )!;
    interviewNode.label = "Customer call";
    interviewNode.shape = "cloud";
    interviewNode.familyData = createMermaidVisualFamilyData("mindmap", {
      ...mermaidVisualFamilyPayload(interviewNode.familyData, "mindmap"),
      shape: "cloud",
    });
    const deliveryNode = mindmapModel.nodes.find(
      (node) => node.label === "Delivery",
    )!;
    mindmapModel.edges = mindmapModel.edges.map((edge) =>
      edge.target === interviewNode.id
        ? { ...edge, source: deliveryNode.id }
        : edge,
    );
    // Free visual edits cannot become a second tree writer. Explicit checked
    // commands retain the previous rename/shape/reparent fidelity coverage.
    expect(
      generateMermaidSourceFromGfxVisualModel(mindmapSource, mindmapModel),
    ).toBe(mindmapSource);
    const sourceTree = readMindmapProjectionModel(mindmapSource, mindmapModel)!;
    const edited = editMindmapNode(sourceTree, interviewNode.id, {
      label: "Customer call",
      shape: "cloud",
    });
    const moved = moveMindmapSubtree(
      edited.model,
      interviewNode.id,
      deliveryNode.id,
    );
    expect(moved.changed).toBe(true);
    expect(moved.source).toContain("mindmap");
    expect(moved.source).toContain("root((Product))");
    expect(moved.source).toContain("    Delivery\n      )Customer call(");
    expect(moved.source).not.toMatch(/^flowchart\b/m);

    const requirementSource =
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Must publish diagrams\n  }\n  element ui {\n    type: userInterface\n  }\n  req1 - satisfies -> ui\n";
    const requirementModel =
      parseMermaidSourceToGfxVisualModel(requirementSource).model!;
    const verifiesRequirement = setMermaidVisualEdgeRequirementRelationKind(
      requirementModel,
      requirementModel.edges[0].id,
      "verifies",
    );
    verifiesRequirement.edges[0].source = "ui";
    verifiesRequirement.edges[0].target = "req1";
    const requirementNext = generateMermaidSourceFromGfxVisualModel(
      requirementSource,
      verifiesRequirement,
    );
    expect(requirementNext).toContain("requirementDiagram");
    expect(requirementNext).toContain("ui - verifies -> req1");
    const parsedRequirementNext =
      parseMermaidRequirementSource(requirementNext);
    expect(parsedRequirementNext?.requirements[0]).toMatchObject({
      id: "req1",
      requirementId: "1",
      text: "Must publish diagrams",
    });
    expect(parsedRequirementNext?.elements[0]).toMatchObject({
      elementType: "userInterface",
      id: "ui",
    });
    expect(requirementNext).not.toMatch(/^flowchart\b/m);

    const sequenceSource =
      "sequenceDiagram\n  participant Alice\n  actor Bob\n  Alice->>Bob: Hello\n";
    const sequenceModel =
      parseMermaidSourceToGfxVisualModel(sequenceSource).model!;
    expect(
      sequenceModel.nodes
        .filter((node) => sequenceNodeGfxData(node)?.role === "participant")
        .filter((node) => !sequenceNodeGfxData(node)?.mirror)
        .map((node) => sequenceNodeGfxData(node)?.participantId),
    ).toEqual(["Alice", "Bob"]);
    expect(
      sequenceModel.nodes
        .filter((node) => sequenceNodeGfxData(node)?.role === "lifeline")
        .map((node) => sequenceNodeGfxData(node)?.participantId),
    ).toEqual(["Alice", "Bob"]);
    expect(sequenceModel.edges[0]).toMatchObject({
      connectorMode: "straight",
      source: sequenceModel.nodes.find(
        (n) =>
          sequenceNodeGfxData(n)?.participantId === "Alice" &&
          sequenceNodeGfxData(n)?.role === "participant",
      )!.id,
      sourceAttachment: sequenceModel.nodes.find(
        (n) =>
          sequenceNodeGfxData(n)?.participantId === "Alice" &&
          sequenceNodeGfxData(n)?.role === "lifeline",
      )!.id,
      sourcePosition: [0.5, expect.any(Number)],
      target: sequenceModel.nodes.find(
        (n) =>
          sequenceNodeGfxData(n)?.participantId === "Bob" &&
          sequenceNodeGfxData(n)?.role === "participant",
      )!.id,
      targetPosition: [0.5, expect.any(Number)],
    });
    sequenceModel.nodes.find(
      (node) =>
        sequenceNodeGfxData(node)?.role === "participant" &&
        sequenceNodeGfxData(node)?.participantId === "Alice" &&
        !sequenceNodeGfxData(node)?.mirror,
    )!.label = "Product Owner";
    sequenceModel.edges[0] = {
      ...sequenceModel.edges[0],
      label: "Approve",
      familyData: sequenceEdgeFamilyData({
        ...sequenceSubgraphGfxData(sequenceModel.edges[0]),
        arrow: "-->>",
      }),
    };
    const sequenceNext = generateMermaidSourceFromGfxVisualModel(
      sequenceSource,
      sequenceModel,
    );
    expect(sequenceNext).toContain("sequenceDiagram");
    expect(sequenceNext).toContain("participant Alice as Product Owner");
    expect(sequenceNext).toContain("Alice-->>Bob: Approve");
    expect(sequenceNext).not.toMatch(/^flowchart\b/m);

    const stateSource =
      "stateDiagram\n  [*] --> Draft\n  Draft --> Done : finish\n  Done --> [*]\n";
    const added = addState(parseMermaidStateSource(stateSource)!, {
      id: "Review",
    });
    const connected = addStateTransition(added.model, {
      from: "Draft",
      to: "Review",
      label: "review",
    });
    expect(connected.status).toBe("changed");
    const stateNext = generateMermaidSourceFromGfxVisualModel(
      connected.source,
      stateModelToVisual(connected.model),
    );
    expect(stateNext).toContain("stateDiagram");
    expect(stateNext).toContain("\n  Review\n");
    expect(stateNext).toContain("Draft --> Review: review");
    expect(stateNext).not.toMatch(/^flowchart\b/m);
  });

  test("serializes new shared-GFX nodes and edges for graph-like Mermaid types without a parseable previous source", () => {
    const blockModel = parseMermaidSourceToGfxVisualModel(
      'block-beta\n  A["Start"]\n  B["Done"]\n  A -- "next" --> B\n',
    ).model!;
    blockModel.nodes.push({
      height: 82,
      id: "C",
      label: "Review",
      shape: "rounded",
      width: 150,
      x: 440,
      y: 80,
    });
    blockModel.edges.push({
      id: "edge-B-C-2",
      label: "review",
      linkType: "arrow",
      source: "B",
      style: "solid",
      target: "C",
    });
    expect(() =>
      generateMermaidSourceFromGfxVisualModel("not parseable", blockModel),
    ).toThrow("Invalid Block Source");

    const c4Model = parseMermaidSourceToGfxVisualModel(
      'C4Context\n  Person(user, "User")\n',
    ).model!;
    c4Model.nodes.push({
      height: 96,
      id: "app",
      label: "Myoxus",
      shape: "rect",
      width: 170,
      x: 280,
      y: 64,
    });
    c4Model.edges.push({
      familyData: c4EdgeFamilyData({
        description: "",
        index: null,
        labelOffsetX: 0,
        labelOffsetY: 0,
        link: "",
        relationshipKind: "Rel",
        sprite: "",
        tags: "",
        technology: "HTTPS",
      }),
      id: "relationship-user-app-1",
      label: "Uses",
      linkType: "arrow",
      source: c4ProjectionSelectionId(c4Model, "element", "user")!,
      style: "solid",
      target: "app",
    });
    expect(() =>
      generateMermaidSourceFromGfxVisualModel("not parseable", c4Model),
    ).toThrow("Cannot rewrite unresolved C4 Source");
    const c4Source = generateMermaidSourceFromGfxVisualModel(
      'C4Context\n  Person(user, "User")\n',
      c4Model,
    );
    expect(c4Source).toContain("C4Context");
    expect(c4Source).toContain('System(app, "Myoxus")');
    expect(c4Source).toContain('Rel(user, app, "Uses", "HTTPS")');

    const classModel = parseMermaidSourceToGfxVisualModel(
      "classDiagram-v2\n  class Order\n",
    ).model!;
    expect(() =>
      generateMermaidSourceFromGfxVisualModel("not parseable", classModel),
    ).toThrow("Invalid Class Source");

    const erModel = parseMermaidSourceToGfxVisualModel(
      "erDiagram\n  ORDER ||--o{ LINE : contains\n",
    ).model!;
    expect(() =>
      generateMermaidSourceFromGfxVisualModel("not parseable", erModel),
    ).toThrow("Invalid ER Source");

    const requirementModel = parseMermaidSourceToGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n",
    ).model!;
    requirementModel.nodes.push({
      height: 86,
      id: "ui",
      label: "UI",
      shape: "rect",
      width: 170,
      x: 420,
      y: 60,
    });
    requirementModel.edges.push({
      familyData: requirementEdgeFamilyData({ relationKind: "satisfies" }),
      id: "relation-req1-ui-1",
      label: "",
      linkType: "arrow",
      source: "req1",
      style: "solid",
      target: "ui",
    });
    const requirementSource = generateMermaidSourceFromGfxVisualModel(
      "",
      requirementModel,
    );
    expect(requirementSource).toContain("requirementDiagram");
    expect(requirementSource).toContain("element ui {");
    expect(requirementSource).toContain("req1 - satisfies -> ui");

    // Invalid previous Source must never trigger a State whole-source rewrite.
    const stateModel = parseMermaidSourceToGfxVisualModel(
      "stateDiagram\n  [*] --> Draft\n",
    ).model!;
    expect(() =>
      generateMermaidSourceFromGfxVisualModel("not parseable", stateModel),
    ).toThrow("Invalid State Source");
  });

  test("uses diagram-specific shape palettes for shared Mermaid GFX editing", () => {
    expect(getMermaidGfxShapePalette("architecture").core).toEqual([
      "subroutine",
      "circle",
    ]);
    // Block shapes are Source commands; its contour is not a generic palette item.
    expect(getMermaidGfxShapePalette("block").core).toEqual(["rect"]);
    expect(getMermaidGfxShapePalette("block").all).not.toContain("block-arrow");
    // C4 kind/notation is authored by its Source catalog, not a shape palette.
    expect(getMermaidGfxShapePalette("c4")).toEqual({ all: [], core: [] });
    expect(getMermaidGfxShapePalette("classDiagram").core).toEqual(["rect"]);
    expect(getMermaidGfxShapePalette("erDiagram").core).toEqual(["rect"]);
    expect(getMermaidGfxShapePalette("gantt").core).toEqual([]);
    expect(getMermaidGfxShapePalette("gitGraph")).toEqual({
      all: [],
      core: [],
    });
    expect(getMermaidGfxShapePalette("journey").core).toEqual([]);
    // Source-owned shapes are edited through family controls, not free GFX.
    expect(getMermaidGfxShapePalette("mindmap")).toEqual({ all: [], core: [] });
    expect(getMermaidGfxShapePalette("requirementDiagram").core).toEqual([
      "doc",
      "rect",
    ]);
    expect(getMermaidGfxShapePalette("stateDiagram-v2").core).toEqual([]);
    expect(getMermaidGfxShapePalette("stateDiagram-v2").all).toEqual([]);
  });

  test("creates Architecture nodes and edges through its FamilyData defaults", () => {
    installProjectedMermaidTestTheme();
    const architectureModel = addMermaidVisualNode(
      parseMermaidSourceToGfxVisualModel(
        "architecture-beta\n  service web(server)[Web]\n",
      ).model!,
    );
    const architectureSource = generateMermaidSourceFromGfxVisualModel(
      "architecture-beta\n  service web(server)[Web]\n",
      connectMermaidVisualNodes(architectureModel, "web", "service2"),
    );
    expect(architectureModel.nodes.at(-1)).toMatchObject({
      id: "service2",
      label: "service2",
      shape: "subroutine",
    });
    expect(architectureSource).toContain("service service2");
    expect(architectureSource).toContain("web:R --> L:service2");
    expect(architectureSource).not.toContain("Process 2");
  });

  test("creates other graph-family nodes and edges with diagram-specific semantics instead of Flowchart defaults", () => {
    const original = parseMermaidBlockDiagramSource(
      'block-beta\n  A["Start"]\n',
    )!;
    const addedBlock = addBlock(original, {
      id: "B2",
      label: "Block 2",
      syntax: "rounded",
    });
    expect(addedBlock.status).toBe("changed");
    const connectedBlock = addBlockConnection(addedBlock.model, {
      from: "A",
      to: "B2",
    });
    expect(connectedBlock.status).toBe("changed");
    expect(connectedBlock.source).toContain('B2("Block 2")');
    expect(connectedBlock.source).toContain("A --> B2");
    expect(connectedBlock.source).not.toContain("Process 2");
    expect(
      parseMermaidBlockDiagramSource(connectedBlock.source)?.nodes.at(-1),
    ).toMatchObject({ id: "B2", label: "Block 2", shape: "rounded" });

    const c4Model = addMermaidVisualNode(
      parseMermaidSourceToGfxVisualModel('C4Context\n  Person(user, "User")\n')
        .model!,
    );
    const c4Source = generateMermaidSourceFromGfxVisualModel(
      'C4Context\n  Person(user, "User")\n',
      connectMermaidVisualNodes(
        c4Model,
        c4ProjectionSelectionId(c4Model, "element", "user")!,
        "Element2",
      ),
    );
    expect(c4Model.nodes).toHaveLength(1);
    expect(c4Model.nodes[0]).toMatchObject({ label: "User", shape: "person" });
    expect(c4Model.edges).toHaveLength(0);
    expect(c4Source).toBe('C4Context\n  Person(user, "User")\n');

    const classModel = parseMermaidClassSource(
      "classDiagram\n  class Document\n",
    )!;
    const addedClass = addClass(classModel, { id: "Class2", label: "Class 2" });
    const connectedClass = connectClasses(addedClass.model, {
      fromSourceId: "Document",
      toSourceId: "Class2",
      kind: "-->",
    });
    expect(connectedClass.source).toContain('class Class2["Class 2"]');
    expect(connectedClass.source).toContain("Document --> Class2");
    expect(
      connectedClass.model.nodes.find((node) => node.sourceId === "Class2")
        ?.label,
    ).toBe("Class 2");

    const erModel = parseMermaidErSource(
      "erDiagram\n  CUSTOMER {\n    string id\n  }\n",
    )!;
    const addedEntity = addErEntity(erModel, { id: "ENTITY2" });
    const connectedEntity = addErRelationship(addedEntity.model, {
      from: "CUSTOMER",
      to: "ENTITY2",
      cardinalityA: "exactly-one",
      cardinalityB: "zero-or-many",
      identification: "--",
      label: "relates",
    });
    expect(connectedEntity.source).toBe(
      erModel.sourceDocument.source +
        "ENTITY2\nCUSTOMER ||--o{ ENTITY2 : relates\n",
    );
    expect(connectedEntity.model.entities.at(-1)).toMatchObject({
      id: "ENTITY2",
      label: "ENTITY2",
      attributes: [],
    });

    const mindmapSource = "mindmap\n  root((Product))\n";
    const mindmapVisual =
      parseMermaidSourceToGfxVisualModel(mindmapSource).model!;
    expect(addMermaidVisualNode(mindmapVisual)).toEqual(mindmapVisual);
    const mindmapTree = readMindmapProjectionModel(
      mindmapSource,
      mindmapVisual,
    )!;
    const child = addMindmapNode(
      mindmapTree,
      "Topic 2",
      mindmapTree.nodes[0].sourceKey,
      "rounded",
    );
    expect(child.changed).toBe(true);
    expect(child.model.nodes.at(-1)).toMatchObject({
      label: "Topic 2",
      shape: "rounded",
      parentId: child.model.nodes[0].id,
    });
    expect(child.source).toContain("root((Product))\n    (Topic 2)");
    expect(child.source).not.toContain("Process 1");

    const requirementModel = addMermaidVisualNode(
      parseMermaidSourceToGfxVisualModel(
        "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n",
      ).model!,
    );
    const requirementSource = generateMermaidSourceFromGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n",
      connectMermaidVisualNodes(requirementModel, "req1", "req2"),
    );
    expect(requirementModel.nodes.at(-1)).toMatchObject({
      id: "req2",
      label: "Requirement 2",
      shape: "doc",
    });
    expect(requirementSource).toContain("requirement req2 {");
    expect(requirementSource).toContain("req1 - satisfies -> req2");
    expect(requirementSource).not.toMatch(/^flowchart\b/m);

    const stateInitial = "stateDiagram-v2\n  [*] --> Draft\n";
    const addedState = addState(parseMermaidStateSource(stateInitial)!, {
      id: "State3",
      label: "State 3",
    });
    const stateSource = addStateTransition(addedState.model, {
      from: "Draft",
      to: "State3",
    }).source;
    const stateModel = parseMermaidSourceToGfxVisualModel(stateSource).model!;
    const third = stateModel.nodes.find((n) => n.label === "State 3")!;
    expect(third).toMatchObject({ shape: "rounded" });
    expect(third.id).not.toBe("State3");
    expect(stateSource).toContain('state "State 3" as State3');
    expect(stateSource).toContain("Draft --> State3");
    expect(stateSource.match(/\[\*\]/g)?.length).toBe(1);
  });

  test("keeps Class members and ER attributes visible on GFX without corrupting source labels", () => {
    const ownerBound = new Bound(0, 0, 800, 600);
    const yMapFromProps = (props: Record<string, unknown>) => ({
      get: (key: string) => props[key],
    });

    const classModel = parseMermaidSourceToGfxVisualModel(
      "classDiagram\n  class Document {\n    +title\n    +diagramSource\n  }\n",
    ).model!;
    const classNode = classModel.nodes[0];
    const classProps = toMermaidShapeElementProps(classNode, ownerBound);
    expect(classNode).toMatchObject({
      displayLabel: "Document",
      label: "Document",
      shape: "rect",
      textAlign: "left",
      textVerticalAlign: "top",
    });
    expect(classNodeGfxData(classNode)).toMatchObject({
      members: ["+title", "+diagramSource"],
    });
    expect(classProps).toMatchObject({
      mermaidNodeDisplayLabel: "Document",
      mermaidNodeLabel: "Document",
      text: "Document",
      textAlign: "left",
      textVerticalAlign: "top",
    });
    const classDetailEntries =
      getMermaidVisualNodeDetailElementEntries(classModel);
    const classDetailProps = classDetailEntries.map(({ detail, node }) =>
      toMermaidNodeDetailElementProps({
        detail,
        ownerBound,
        node,
        projection: typeOwnedMermaidNodeDetailElementProjection(
          classModel,
          node,
          detail,
        )!,
      }),
    );
    const classMembers = classNode.details!.filter(
      (detail) => detail.kind !== "separator",
    );
    expect(classDetailProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mermaidDetailId: classMembers[0].id,
          mermaidDetailOwnerNodeId: classNode.id,
          mermaidRole: MERMAID_GFX_DETAIL_ROLE,
          text: "+title",
        }),
        expect.objectContaining({
          mermaidDetailId: classMembers[1].id,
          mermaidDetailOwnerNodeId: classNode.id,
          mermaidRole: MERMAID_GFX_DETAIL_ROLE,
          text: "+diagramSource",
        }),
      ]),
    );
    const classRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "classDiagram",
      direction: "TD",
      elements: [
        {
          id: "class-shape",
          text: classProps.text as string,
          type: "shape",
          xywh: classProps.xywh as string,
          yMap: yMapFromProps(classProps),
        },
        ...classDetailEntries.map(({ elementId }, index) => ({
          id: elementId,
          text:
            classDetailEntries[index].detail.id === classMembers[1].id
              ? "+exportPdf(): Blob"
              : (classDetailProps[index]?.text as string),
          type: "shape" as const,
          xywh: classDetailProps[index]?.xywh as string,
          yMap: yMapFromProps(classDetailProps[index] ?? {}),
        })),
      ],
      ownerBound,
      previousModel: classModel,
    });
    expectMermaidVisualModel(classRoundtrip);
    const editedClassSource = generateMermaidSourceFromGfxVisualModel(
      "classDiagram\n  class Document {\n    +title\n    +diagramSource\n  }\n",
      classRoundtrip,
    );
    expect(editedClassSource).toBe(
      "classDiagram\n  class Document {\n    +title\n    +exportPdf(): Blob\n  }\n",
    );

    const erSource =
      "erDiagram\n  CUSTOMER {\n    string id PK\n    string name\n  }\n";
    const erModel = parseMermaidSourceToGfxVisualModel(erSource).model!;
    const erNode = erModel.nodes[0];
    const erProps = toMermaidShapeElementProps(erNode, ownerBound);
    expect(erNode).toMatchObject({
      displayLabel: "CUSTOMER",
      label: "CUSTOMER",
      shape: "rect",
      textAlign: "left",
      textVerticalAlign: "top",
    });
    const erSemantic = readErProjectionModel(erSource, erModel)!;
    expect(erSemantic.entities[0].attributes).toMatchObject([
      { keys: ["PK"], name: "id", type: "string" },
      { keys: [], name: "name", type: "string" },
    ]);
    const [id, name] = erSemantic.entities[0].attributes;
    const erDetailEntries = getMermaidVisualNodeDetailElementEntries(erModel);
    const erDetailProps = erDetailEntries.map(({ detail, node }) =>
      toMermaidNodeDetailElementProps({
        detail,
        ownerBound,
        node,
        projection: typeOwnedMermaidNodeDetailElementProjection(
          erModel,
          node,
          detail,
        )!,
      }),
    );
    expect(erDetailProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mermaidDetailId: id.id,
          mermaidDetailOwnerNodeId: erNode.id,
          mermaidRole: MERMAID_GFX_DETAIL_ROLE,
          text: "id",
        }),
        expect.objectContaining({
          mermaidDetailId: name.id,
          mermaidDetailOwnerNodeId: erNode.id,
          mermaidRole: MERMAID_GFX_DETAIL_ROLE,
          text: "name",
        }),
        expect.objectContaining({ mermaidDetailSourceKey: id.id, text: "PK" }),
      ]),
    );
    const movedBound = new Bound(
      erNode.x + 42,
      erNode.y + 11,
      erNode.width + 30,
      erNode.height,
    ).serialize();
    const erRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "erDiagram",
      direction: erModel.direction,
      ownerBound,
      previousModel: erModel,
      elements: [
        {
          id: "er-shape",
          text: erProps.text as string,
          type: "shape",
          xywh: movedBound,
          yMap: yMapFromProps(erProps),
        },
        ...erDetailEntries.map(({ elementId, detail }, index) => ({
          id: elementId,
          text:
            detail.id === name.id
              ? "unauthorised raw field edit"
              : (erDetailProps[index].text as string),
          type: "shape" as const,
          xywh: erDetailProps[index].xywh as string,
          yMap: yMapFromProps(erDetailProps[index]),
        })),
      ],
    });
    expectMermaidVisualModel(erRoundtrip);
    expect(erRoundtrip.nodes[0]).toMatchObject({
      id: erNode.id,
      x: erNode.x + 42,
      y: erNode.y + 11,
      width: erNode.width + 30,
    });
    expect(
      readErProjectionModel(erSource, erRoundtrip)!.entities[0].attributes.map(
        (a) => a.name,
      ),
    ).toEqual(["id", "name"]);
    expect(generateMermaidSourceFromGfxVisualModel(erSource, erRoundtrip)).toBe(
      erSource,
    );
    const editedEr = editErAttribute(erSemantic, name.id, {
      name: "workspace_id",
      type: "uuid",
      keys: ["FK"],
    });
    expect(editedEr.changed).toBe(true);
    expect(editedEr.source).toBe(
      erSource.replace("string name", "uuid workspace_id FK"),
    );
    expect(editedEr.model.entities[0].attributes.map((a) => a.id)).toEqual([
      id.id,
      name.id,
    ]);

    const c4NodeModel = parseMermaidSourceToGfxVisualModel(
      'C4Context\n  ContainerDb(app, "Myoxus", "Workspace data", "Postgres")\n',
    ).model!;
    const c4Node = c4NodeModel.nodes[0];
    const c4NodeProps = toMermaidShapeElementProps(c4Node, ownerBound);
    expect(c4NodeProps).toMatchObject({
      mermaidNodeFamilyData: expect.stringContaining('"family":"c4"'),
      mermaidNodeLabel: "Myoxus",
    });
    const c4NodeRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "c4",
      direction: "TD",
      elements: [
        {
          id: "c4-app",
          text: c4NodeProps.text as string,
          type: "shape",
          xywh: c4NodeProps.xywh as string,
          yMap: yMapFromProps(c4NodeProps),
        },
      ],
      ownerBound,
      previousModel: c4NodeModel,
    });
    expectMermaidVisualModel(c4NodeRoundtrip);
    expect(c4NodeRoundtrip.nodes[0]).toMatchObject({
      label: "Myoxus",
    });
    expect(c4NodeGfxData(c4NodeRoundtrip.nodes[0])).toMatchObject({
      description: "Postgres",
      effectiveTechnology: "Workspace data",
      kind: "ContainerDb",
    });

    const mindmapModel = parseMermaidSourceToGfxVisualModel(
      "mindmap\n  root((Product))\n    Discovery\n",
    ).model!;
    const mindmapNode = mindmapModel.nodes[1];
    const mindmapProps = toMermaidShapeElementProps(mindmapNode, ownerBound);
    expect(mindmapNode).toMatchObject({
      label: "Discovery",
      shape: "rounded",
    });
    expect(
      mermaidVisualFamilyPayload(mindmapNode.familyData, "mindmap")?.shape,
    ).toBe("default");
    expect(mindmapProps).toMatchObject({
      mermaidNodeFamilyData: expect.stringContaining('"family":"mindmap"'),
      mermaidNodeLabel: "Discovery",
      text: "Discovery",
    });
    const mindmapRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "mindmap",
      direction: "LR",
      elements: [
        {
          id: "mindmap-shape",
          text: mindmapProps.text as string,
          type: "shape",
          xywh: mindmapProps.xywh as string,
          yMap: yMapFromProps(mindmapProps),
        },
      ],
      ownerBound,
      previousModel: mindmapModel,
    });
    expectMermaidVisualModel(mindmapRoundtrip);
    const restoredMindmapNode = mindmapRoundtrip.nodes.find(
      (node) => node.id === mindmapNode.id,
    )!;
    expect(restoredMindmapNode).toMatchObject({
      label: "Discovery",
      shape: "rounded",
    });
    expect(
      mermaidVisualFamilyPayload(restoredMindmapNode.familyData, "mindmap")
        ?.shape,
    ).toBe("default");
  });

  test("roundtrips Architecture node presentation through its FamilyData GFX contract", () => {
    installProjectedMermaidTestTheme();
    const ownerBound = new Bound(0, 0, 800, 600);
    const yMapFromProps = (props: Record<string, unknown>) => ({
      get: (key: string) => props[key],
    });
    const architectureModel = parseMermaidSourceToGfxVisualModel(
      "architecture-beta\n  group web(icon)[Web]\n  service app(server)[App] in web\n  service db(database)[DB] in web\n",
    ).model!;
    const architectureNode = architectureModel.nodes.find(
      (node) => node.id === "app",
    )!;
    const architectureProps = toMermaidShapeElementProps(
      architectureNode,
      ownerBound,
    );
    const editedArchitectureProps = {
      ...architectureProps,
      mermaidNodeDisplayLabel: "Frontend\n⛁",
      mermaidNodeFamilyData: JSON.stringify(
        architectureNodeFamilyData({
          ...architectureNodeGfxData(architectureNode)!,
          hasIcon: true,
          hasLabel: true,
          icon: "database",
          iconKind: "icon",
          label: "Frontend",
        }),
      ),
      mermaidNodeLabel: "Frontend",
      text: "Frontend\n⛁",
    };
    const architectureRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "architecture",
      direction: "TD",
      elements: [
        {
          id: "architecture-app-shape",
          props: editedArchitectureProps,
          text: editedArchitectureProps.text,
          type: "shape",
          xywh: editedArchitectureProps.xywh as string,
        },
      ],
      ownerBound,
      previousModel: architectureModel,
    });
    expectMermaidVisualModel(architectureRoundtrip);
    expect(architectureRoundtrip.nodes).toHaveLength(1);
    expect(architectureRoundtrip.nodes[0]).toMatchObject({
      displayLabel: "Frontend\n⛁",
      id: "app",
      label: "Frontend",
    });
    expect(
      architectureNodeGfxData(architectureRoundtrip.nodes[0]),
    ).toMatchObject({
      hasIcon: true,
      hasLabel: true,
      icon: "database",
      iconKind: "icon",
      label: "Frontend",
    });
    const flattenedArchitectureRoundtrip =
      createMermaidVisualModelFromGfxElements({
        diagramType: "architecture",
        direction: "TD",
        elements: [
          {
            id: "architecture-app-shape-flattened",
            text: { toString: () => "Frontend⛁" },
            type: "shape",
            xywh: editedArchitectureProps.xywh as string,
            yMap: yMapFromProps(editedArchitectureProps),
          },
        ],
        ownerBound,
        previousModel: architectureModel,
      });
    expectMermaidVisualModel(flattenedArchitectureRoundtrip);
    expect(flattenedArchitectureRoundtrip.nodes[0]).toMatchObject({
      displayLabel: "Frontend\n⛁",
      id: "app",
      label: "Frontend",
    });
    expect(
      architectureNodeGfxData(flattenedArchitectureRoundtrip.nodes[0]),
    ).toMatchObject({
      hasIcon: true,
      hasLabel: true,
      icon: "database",
      iconKind: "icon",
      label: "Frontend",
    });
  });

  test("edits Architecture edge ports through its FamilyData GFX contract", () => {
    installProjectedMermaidTestTheme();
    const architectureModel = parseMermaidSourceToGfxVisualModel(
      'architecture-beta\n  service web(server)[Web]\n  service db(database)[Database]\n  web:R -["reads"]- L:db\n',
    ).model!;
    const architectureEdge = architectureModel.edges[0];
    const topToBottom = {
      ...architectureModel,
      edges: architectureModel.edges.map((edge) =>
        edge.id === architectureEdge.id
          ? {
              ...edge,
              familyData: architectureEdgeFamilyData({
                ...architectureEdgeGfxData(edge),
                fromPort: "B",
                toPort: "T",
              }),
              sourcePosition: [0.5, 1] as const,
              targetPosition: [0.5, 0] as const,
            }
          : edge,
      ),
    };
    const architectureSource = generateMermaidSourceFromGfxVisualModel(
      'architecture-beta\n  service web(server)[Web]\n  service db(database)[Database]\n  web:R -["reads"]- L:db\n',
      topToBottom,
    );
    expect(architectureSource).toContain('web:B -["reads"]- T:db');
    expect(
      resolveMermaidGfxEdgeEndpointPositions(topToBottom.edges[0]),
    ).toEqual({
      sourcePosition: [0.5, 1],
      targetPosition: [0.5, 0],
    });
    expect(topToBottom.edges[0].labelPlacement).toBe("top");
    const connectorProps = toMermaidConnectorElementProps(
      topToBottom.edges[0],
      new Map([
        ["web", "gfx-web"],
        ["db", "gfx-db"],
      ]),
    );
    expect(connectorProps).toMatchObject({
      mermaidEdgeLabelPlacement: "top",
      source: { id: "gfx-web", position: [0.5, 1] },
      target: { id: "gfx-db", position: [0.5, 0] },
    });
    expect(JSON.parse(connectorProps.mermaidEdgeFamilyData)).toMatchObject({
      family: "architecture",
      payload: { fromPort: "B", toPort: "T" },
      version: 1,
    });
  });

  test("edits diagram-family edge metadata through owner GFX data", () => {
    const ownerBound = new Bound(0, 0, 800, 600);
    const c4Model = parseMermaidSourceToGfxVisualModel(
      'C4Context\n  Person(user, "User")\n  System(app, "Myoxus")\n  Rel(user, app, "Uses", "HTTPS")\n',
    ).model!;
    const bidirectionalC4 = setMermaidVisualEdgeC4Relationship(
      c4Model,
      c4Model.edges[0].id,
      "BiRel",
      "GraphQL",
    );
    const c4Source = generateMermaidSourceFromGfxVisualModel(
      'C4Context\n  Person(user, "User")\n  System(app, "Myoxus")\n  Rel(user, app, "Uses", "HTTPS")\n',
      bidirectionalC4,
    );
    expect(c4Source).toContain('BiRel(user, app, "Uses", "GraphQL")');
    expect(
      toMermaidConnectorElementProps(
        bidirectionalC4.edges[0],
        new Map([
          [c4ProjectionSelectionId(c4Model, "element", "user")!, "gfx-user"],
          [c4ProjectionSelectionId(c4Model, "element", "app")!, "gfx-app"],
        ]),
      ),
    ).toMatchObject({
      mermaidEdgeFamilyData: expect.stringContaining('"family":"c4"'),
    });

    const classModel = parseMermaidSourceToGfxVisualModel(
      "classDiagram\n  class Parent\n  class Child\n  Parent <|-- Child : owns\n",
    ).model!;
    expect(classModel.edges[0]).toMatchObject({
      label: "owns",
    });
    expect(classEdgeGfxData(classModel.edges[0])).toMatchObject({
      relationKind: "<|--",
    });
    const composedClass = {
      ...classModel,
      edges: classModel.edges.map((edge) =>
        classRelationProjection(
          {
            ...parseMermaidClassSource(
              "classDiagram\nParent *-- Child : owns\n",
            )!.relations[0],
            id: edge.id,
            sourceKey: edge.id,
          },
          new Map([
            ["Parent", edge.source],
            ["Child", edge.target],
          ]),
        ),
      ),
    };
    const classSource = generateMermaidSourceFromGfxVisualModel(
      "classDiagram\n  class Parent\n  class Child\n  Parent <|-- Child : owns\n",
      composedClass,
    );
    expect(classSource).toContain("Parent *-- Child : owns");
    expect(
      toMermaidConnectorElementProps(
        composedClass.edges[0],
        new Map([
          [composedClass.edges[0].source, "gfx-parent"],
          [composedClass.edges[0].target, "gfx-child"],
        ]),
      ),
    ).toMatchObject({
      labelOffset: {
        anchor: ConnectorLabelOffsetAnchor.Top,
        distance: 0.5,
      },
      mermaidEdgeLabelPlacement: "top",
    });
    expect(
      parseMermaidVisualFamilyData(
        toMermaidConnectorElementProps(
          composedClass.edges[0],
          new Map([
            [composedClass.edges[0].source, "gfx-parent"],
            [composedClass.edges[0].target, "gfx-child"],
          ]),
        ).mermaidEdgeFamilyData,
      ),
    ).toEqual(composedClass.edges[0].familyData);

    const erModel = parseMermaidSourceToGfxVisualModel(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
    ).model!;
    expect(erModel.edges[0]).toMatchObject({
      label: "places",
    });
    expect(erEdgeGfxData(erModel.edges[0])).toMatchObject({
      cardinalityA: "exactly-one",
      cardinalityB: "zero-or-many",
      identification: "--",
    });
    const erSemantic = readErProjectionModel(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
      erModel,
    )!;
    const oneToOneSemantic = editErRelationship(
      erSemantic,
      erSemantic.relationships[0].id,
      { cardinalityB: "exactly-one" },
    ).model;
    const oneToOne = erModelToVisual(oneToOneSemantic);
    const erSource = generateMermaidSourceFromGfxVisualModel(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
      oneToOne,
    );
    expect(erSource).toContain("CUSTOMER ||--|| ORDER : places");
    expect(
      toMermaidConnectorElementProps(
        oneToOne.edges[0],
        new Map([
          [erModel.nodes[0].id, "gfx-customer"],
          [erModel.nodes[1].id, "gfx-order"],
        ]),
      ),
    ).toMatchObject({
      frontEndpointStyle: "DoubleBar",
      labelOffset: {
        anchor: ConnectorLabelOffsetAnchor.Top,
        distance: 0.5,
      },
      mermaidEdgeLabelPlacement: "top",
      rearEndpointStyle: "DoubleBar",
    });
    expect(
      toMermaidConnectorElementProps(
        erModel.edges[0],
        new Map([
          [erModel.nodes[0].id, "gfx-customer"],
          [erModel.nodes[1].id, "gfx-order"],
        ]),
      ),
    ).toMatchObject({
      frontEndpointStyle: "DoubleBar",
      labelOffset: {
        anchor: ConnectorLabelOffsetAnchor.Top,
        distance: 0.5,
      },
      mermaidEdgeLabelPlacement: "top",
      rearEndpointStyle: "CircleCrowFoot",
    });
    const optionalToMany = erModelToVisual(
      editErRelationship(erSemantic, erSemantic.relationships[0].id, {
        cardinalityA: "zero-or-one",
        cardinalityB: "one-or-many",
      }).model,
    );
    expect(
      toMermaidConnectorElementProps(
        optionalToMany.edges[0],
        new Map([
          [erModel.nodes[0].id, "gfx-customer"],
          [erModel.nodes[1].id, "gfx-order"],
        ]),
      ),
    ).toMatchObject({
      frontEndpointStyle: "CircleBar",
      rearEndpointStyle: "BarCrowFoot",
    });

    const requirementModel = parseMermaidSourceToGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n  element ui {\n    type: userInterface\n  }\n  req1 - satisfies -> ui\n",
    ).model!;
    const verifies = setMermaidVisualEdgeRequirementRelationKind(
      requirementModel,
      requirementModel.edges[0].id,
      "verifies",
    );
    const requirementSource = generateMermaidSourceFromGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n  element ui {\n    type: userInterface\n  }\n  req1 - satisfies -> ui\n",
      verifies,
    );
    expect(requirementSource).toContain("req1 - verifies -> ui");
    expect(
      toMermaidConnectorElementProps(
        verifies.edges[0],
        new Map([
          ["req1", "gfx-req1"],
          ["ui", "gfx-ui"],
        ]),
      ),
    ).toMatchObject({
      mermaidEdgeFamilyData: expect.stringContaining('"family":"requirement"'),
    });

    const connectorRoundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "erDiagram",
      direction: "TD",
      elements: [
        {
          id: "customer",
          text: "CUSTOMER",
          type: "shape",
          xywh: new Bound(20, 20, 170, 96).serialize(),
          yMap: {
            get: (key) =>
              ({
                mermaidNodeId: erModel.nodes[0].id,
                mermaidRole: "mermaid-flowchart-node",
              })[key],
          },
        },
        {
          id: "order",
          text: "ORDER",
          type: "shape",
          xywh: new Bound(260, 20, 170, 96).serialize(),
          yMap: {
            get: (key) =>
              ({
                mermaidNodeId: erModel.nodes[1].id,
                mermaidRole: "mermaid-flowchart-node",
              })[key],
          },
        },
        {
          id: "relationship",
          source: { id: "customer" },
          target: { id: "order" },
          text: "places",
          type: "connector",
          yMap: {
            get: (key) =>
              ({
                mermaidEdgeFamilyData: serializeMermaidVisualFamilyData(
                  erEdgeFamilyData(oneToOneSemantic.relationships[0]),
                ),
                mermaidEdgeId: erModel.edges[0].id,
                mermaidRole: "mermaid-flowchart-edge",
              })[key],
          },
        },
      ],
      ownerBound,
      previousModel: erModel,
    });
    expectMermaidVisualModel(connectorRoundtrip);
    expect(connectorRoundtrip.edges[0]).toMatchObject({
      label: "places",
    });
    expect(erEdgeGfxData(connectorRoundtrip.edges[0])).toMatchObject({
      cardinalityA: "exactly-one",
      cardinalityB: "exactly-one",
      identification: "--",
    });
  });

  test("roundtrips C4 element and relationship edits through semantic model", () => {
    const model = parseMermaidC4Source(
      'C4Context\n  Person(user, "User", "Uses docs")\n  System(app, "Myoxus", "Workspace", "Rust")\n  Rel(user, app, "Uses", "HTTPS")\n',
    )!;
    const renamedElement = renameMermaidC4Element(model, "app", "Myoxus Web");
    const renamedRelationship = renameMermaidC4Relationship(
      renamedElement,
      model.relationships[0].id,
      "Publishes",
    );
    const source = generateMermaidC4Source(renamedRelationship);
    const parsed = parseMermaidC4Source(source);

    expect(source).toContain('System(app, "Myoxus Web", "Workspace", "Rust")');
    expect(source).toContain('Rel(user, app, "Publishes", "HTTPS")');
    expect(parsed?.relationships[0]).toMatchObject({
      label: "Publishes",
      technology: "HTTPS",
    });
  });

  test("adds C4 relationships through the semantic visual model", () => {
    const model = parseMermaidC4Source(
      'C4Context\n  Person(user, "User", "Uses docs")\n  System(app, "Myoxus", "Workspace", "Rust")\n',
    )!;
    const connected = addMermaidC4Relationship(model, "user", "app", {
      label: "Publishes",
      technology: "HTTPS",
    });
    const source = generateMermaidC4Source(connected);
    const parsed = parseMermaidC4Source(source);

    expect(source).toContain('Rel(user, app, "Publishes", "HTTPS")');
    expect(parsed?.relationships[0]).toMatchObject({
      from: "user",
      label: "Publishes",
      technology: "HTTPS",
      to: "app",
    });
  });

  test("roundtrips architecture service and edge edits through semantic model", () => {
    const model = parseMermaidArchitectureSource(
      'architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[Database] in api\n  web:R -["reads"]-> L:db\n',
    )!;
    const renamedService = renameMermaidArchitectureService(
      model,
      "web",
      "Frontend",
    );
    const renamedEdge = renameMermaidArchitectureEdge(
      renamedService.model,
      model.edges[0].id,
      "queries",
    );
    const source = generateMermaidArchitectureSource(renamedEdge.model);
    const parsed = parseMermaidArchitectureSource(source);

    expect(renamedService).toMatchObject({
      changed: true,
      focusAfter: "service-label",
      selectionAfter: { id: "web", kind: "service" },
    });
    expect(renamedEdge).toMatchObject({
      changed: true,
      focusAfter: "edge-label",
      selectionAfter: { id: model.edges[0].id, kind: "edge" },
    });
    expect(source).toContain('service web(server)["Frontend"] in api');
    expect(source).toContain('web:R -["queries"]-> L:db');
    expect(
      parsed?.services.find((service) => service.id === "web"),
    ).toMatchObject({
      groupId: "api",
      label: "Frontend",
    });
  });

  test("adds architecture edges through the semantic visual model", () => {
    const model = parseMermaidArchitectureSource(
      "architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[Database] in api\n",
    )!;
    const connected = addMermaidArchitectureEdge(model, "web", "db", {
      label: "queries",
    });
    const source = generateMermaidArchitectureSource(connected.model);
    const parsed = parseMermaidArchitectureSource(source);

    expect(connected).toMatchObject({
      changed: true,
      focusAfter: "canvas",
      selectionAfter: { kind: "edge" },
    });
    expect(source).toContain('web:R -["queries"]-> L:db');
    expect(parsed?.edges[0]).toMatchObject({
      from: "web",
      fromPort: "R",
      label: "queries",
      to: "db",
      toPort: "L",
    });
  });

  test("diagnoses Architecture command no-ops and invalid targets without changing the model", () => {
    const model = parseMermaidArchitectureSource(
      "architecture-beta\n  service web(server)[Web]\n",
    )!;
    const unchanged = renameMermaidArchitectureService(model, "web", "Web");
    const missingEdge = addMermaidArchitectureEdge(model, "web", "missing");

    expect(unchanged).toMatchObject({
      changed: false,
      diagnosis: { code: "architecture.no-change" },
      model,
      selectionAfter: { id: "web", kind: "service" },
    });
    expect(missingEdge).toMatchObject({
      changed: false,
      diagnosis: { code: "architecture.edge-endpoint-not-found" },
      model,
    });
  });

  test("roundtrips block node and edge edits through semantic model", () => {
    const model = parseMermaidBlockDiagramSource(
      'block-beta\n  columns 2\n  A["Start"]\n  B["Done"]\n  A -- "next" --> B\n',
    )!;
    const renamedNode = renameMermaidBlockDiagramNode(model, "A", "Begin");
    const renamedEdge = renameMermaidBlockDiagramEdge(
      renamedNode,
      model.edges[0].id,
      "finish",
    );
    const source = generateMermaidBlockDiagramSource(renamedEdge);
    const parsed = parseMermaidBlockDiagramSource(source);

    expect(source).toContain("columns 2");
    expect(source).toContain('A["Begin"]');
    expect(source).toContain('A -- "finish" --> B');
    expect(parsed?.nodes.find((node) => node.id === "A")?.label).toBe("Begin");
    expect(parsed?.edges[0].label).toBe("finish");
  });

  test("adds block diagram edges through the semantic visual model", () => {
    const model = parseMermaidBlockDiagramSource(
      'block-beta\n  columns 2\n  A["Start"]\n  B["Done"]\n',
    )!;
    const connected = addMermaidBlockDiagramEdge(model, "A", "B", "next");
    const source = generateMermaidBlockDiagramSource(connected);
    const parsed = parseMermaidBlockDiagramSource(source);

    expect(source).toContain('A -- "next" --> B');
    expect(parsed?.edges[0]).toMatchObject({
      from: "A",
      label: "next",
      to: "B",
    });
  });

  test("patches and reorders duplicate ER attributes with their own trivia, bytes and stable keys", () => {
    const source =
      '---\r\nconfig: {er: {nodeSpacing: 90}, retained: {format: "raw"}}\r\n---\r\nerDiagram\r\n  CUSTOMER {\r\n    string id PK\r\n    %% owning duplicate\r\n    string id FK, UK "Owning account"\r\n  }\r\n  ORDER\r\n  CUSTOMER one to zero or more ORDER : owns\r\n  classDef accent fill:#aaccee,color:#112233';
    const model = parseMermaidErSource(source)!;
    const [first, second] = model.entities[0].attributes;
    expect(first.id).not.toBe(second.id);
    const comment = model.commentRecords[0];
    expect(comment.anchorId).toBe(second.id);
    const edited = editErAttribute(model, second.id, { name: "customer_ref" });
    const editedSource = source.replace(
      'string id FK, UK "Owning account"',
      'string customer_ref FK, UK "Owning account"',
    );
    expect(edited.source).toBe(editedSource);
    expect(edited.model.entities[0].attributes.map((a) => a.id)).toEqual([
      first.id,
      second.id,
    ]);
    const moved = reorderErAttribute(edited.model, second.id, first.id);
    expect(moved.source).toBe(
      editedSource.replace(
        '    string id PK\r\n    %% owning duplicate\r\n    string customer_ref FK, UK "Owning account"',
        '    %% owning duplicate\r\n    string customer_ref FK, UK "Owning account"\r\n    string id PK',
      ),
    );
    expect(moved.model.entities[0].attributes.map((a) => a.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      new Set(moved.model.sourceDocument.records.map((r) => r.sourceKey)),
    ).toEqual(new Set(model.sourceDocument.records.map((r) => r.sourceKey)));
    expect(moved.model.commentRecords[0]).toMatchObject({
      id: comment.id,
      anchorId: second.id,
    });
    for (const [options, reason] of [
      [{ baseSource: source }, "conflict"],
      [{ readonly: true }, "readonly"],
      [{ intent: "cancel" as const }, "cancelled"],
    ] as const) {
      const rejected = editErAttribute(
        moved.model,
        second.id,
        { name: "lost" },
        options,
      );
      expect(rejected).toMatchObject({
        changed: false,
        patches: [],
        source: moved.source,
        reason,
      });
      expect(rejected.model).toBe(moved.model);
    }
  });

  test("roundtrips ER relationship label edits through semantic model", () => {
    const model = parseMermaidErSource(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
    )!;
    const renamed = editErRelationship(model, model.relationships[0].id, {
      label: "owns",
    });
    const source = renamed.source;

    expect(source).toContain("CUSTOMER ||--o{ ORDER : owns");
    expect(parseMermaidErSource(source)?.relationships[0].label).toBe("owns");
  });

  test("adds ER relationships and changes cardinality through the semantic visual model", () => {
    const model = parseMermaidErSource(
      "erDiagram\n  CUSTOMER {\n    string name\n  }\n  ORDER {\n    string id PK\n  }\n",
    )!;
    const connected = addErRelationship(model, {
      from: "CUSTOMER",
      to: "ORDER",
      cardinalityA: "exactly-one",
      cardinalityB: "zero-or-many",
      identification: "--",
      label: "places",
    });
    const manyToOne = editErRelationship(
      connected.model!,
      connected.model!.relationships[0].id,
      { cardinalityA: "zero-or-many", cardinalityB: "exactly-one" },
    );
    const source = manyToOne.source;
    const reparsed = parseMermaidErSource(source);

    expect(source).toContain("CUSTOMER }o--|| ORDER : places");
    expect(reparsed?.relationships[0]).toMatchObject({
      from: "CUSTOMER",
      fromCardinality: "}o",
      label: "places",
      to: "ORDER",
      toCardinality: "||",
    });
    const relationshipKey = manyToOne.model.relationships[0].id;
    const self = reconnectErRelationship(
      manyToOne.model,
      relationshipKey,
      "to",
      "CUSTOMER",
    );
    expect(self.source).toBe(source.replace("}o--|| ORDER", "}o--|| CUSTOMER"));
    expect(self.model.relationships[0]).toMatchObject({
      id: relationshipKey,
      cardinalityA: "zero-or-many",
      cardinalityB: "exactly-one",
    });
    const parallel = addErRelationship(manyToOne.model, {
      from: "CUSTOMER",
      to: "ORDER",
      cardinalityA: "zero-or-one",
      cardinalityB: "one-or-many",
      identification: "..",
      label: "approves",
    });
    expect(parallel.model.relationships[0].id).toBe(relationshipKey);
    expect(parallel.model.relationships[1].id).not.toBe(relationshipKey);
    expect(parallel.source).toBe(source + "CUSTOMER o|..|{ ORDER : approves\n");
  });

  test("patches Class identity and repeated member records without touching opaque bytes", () => {
    const source =
      'classDiagram-v2\r\nnamespace commerce["Commerce"] {\r\n  class Document {\r\n    +id: UUID\r\n    %% identifier comment\r\n    +id: UUID\r\n  }\r\n}\r\nclass Export\r\nDocument "1" *-- "1..*" Export : owns\r\nclick Document call opaqueCallback "Keep callback"';
    const model = parseMermaidClassSource(source)!;
    const titled = editClassDiagramTitle(model, "Record ownership");
    expect(titled.changed).toBe(true);
    expect(titled.source.endsWith(source)).toBe(true);
    expect(
      titled.source.startsWith('---\r\ntitle: "Record ownership"\r\n---\r\n'),
    ).toBe(true);
    expect(titled.model.nodes[0].members.map((entry) => entry.id)).toEqual(
      model.nodes[0].members.map((entry) => entry.id),
    );
    const member = model.nodes.find((node) => node.sourceId === "Document")!
      .members[1];
    const edited = editClassMember(model, member.id, { name: "recordId" });
    expect(edited.changed).toBe(true);
    expect(edited.source).toBe(
      source.replace(
        "%% identifier comment\r\n    +id: UUID",
        "%% identifier comment\r\n    +recordId: UUID",
      ),
    );
    expect(edited.model.nodes[0].members.map((entry) => entry.id)).toEqual(
      model.nodes[0].members.map((entry) => entry.id),
    );
    const stale = editClassMember(
      edited.model,
      member.id,
      { name: "stale" },
      { baseSource: source },
    );
    expect(stale.changed).toBe(false);
    expect(stale.source).toBe(edited.source);
    const renamed = editClass(edited.model, edited.model.nodes[0].sourceKey, {
      id: "Record",
      label: "Page",
    });
    expect(renamed.source).toContain('Record "1" *-- "1..*" Export : owns');
    expect(renamed.source).toContain(
      'click Record call opaqueCallback "Keep callback"',
    );
    expect(renamed.source).toContain("+recordId: UUID");
    const nested = addClassNamespace(renamed.model, {
      id: "shipping",
      label: "Shipping",
      parentId: "commerce",
    });
    expect(
      nested.model.namespaces.find((namespace) => namespace.id === "commerce")
        ?.label,
    ).toBe("Commerce");
  });

  test("roundtrips sequence participant and message edits through semantic model", () => {
    const model = parseMermaidSequenceSource(
      "sequenceDiagram\n  participant Alice\n  actor Bob\n  Alice->>Bob: Hello\n",
    )!;
    const renamedParticipant = renameMermaidSequenceParticipant(
      model,
      "Alice",
      "Product Owner",
    );
    const renamedMessage = renameMermaidSequenceMessage(
      renamedParticipant,
      model.messages[0].id,
      "Approve",
    );
    const source = generateMermaidSequenceSource(renamedMessage);

    expect(source).toContain("participant Alice as Product Owner");
    expect(source).toContain("Alice->>Bob: Approve");
    expect(parseMermaidSequenceSource(source)?.messages[0].label).toBe(
      "Approve",
    );
  });

  test("adds sequence messages through the semantic visual model", () => {
    const model = parseMermaidSequenceSource(
      "sequenceDiagram\n  participant User\n  participant Myoxus\n  User->>Myoxus: Request\n",
    )!;
    const next = addMermaidSequenceMessage(model, "Myoxus", "User", {
      arrow: "-->>",
      label: "Done",
    });
    const source = generateMermaidSequenceSource(next);
    const reparsed = parseMermaidSequenceSource(source);

    expect(source).toContain("Myoxus-->>User: Done");
    expect(reparsed?.messages).toHaveLength(2);
    expect(reparsed?.messages[1]).toMatchObject({
      arrow: "-->>",
      from: "Myoxus",
      label: "Done",
      to: "User",
    });
  });

  test("roundtrips state node and transition edits through semantic model", () => {
    const model = parseMermaidStateSource(
      'stateDiagram\n  [*] --> A\n  state "Review" as A\n  A --> B : approve\n  B --> [*]\n',
    )!;
    const renamedNode = setStateHeading(model, "A", "QA Review");
    const renamedTransition = editStateTransition(
      renamedNode.model,
      model.transitions[1].id,
      { label: "ship" },
    );
    expect(renamedTransition.status).toBe("changed");
    const source = renamedTransition.source;
    const parsed = parseMermaidStateSource(source);

    expect(source).toContain('state "QA Review" as A');
    expect(source).toContain("[*] --> A");
    expect(source).toContain("A --> B : ship");
    expect(source).toContain("B --> [*]");
    expect(
      parsed?.states.filter((state) => state.kind === "start"),
    ).toHaveLength(1);
    expect(parsed?.states.filter((state) => state.kind === "end")).toHaveLength(
      1,
    );
    expect(parsed?.transitions[1].label).toBe("ship");
  });

  test("adds state transitions through the semantic visual model", () => {
    const model = parseMermaidStateSource(
      'stateDiagram-v2\n  [*] --> A\n  state "Review" as A\n  Done\n',
    )!;
    const connected = addStateTransition(model, {
      from: "A",
      to: "Done",
      label: "approve",
    });
    expect(connected.status).toBe("changed");
    const source = connected.source;
    const reparsed = parseMermaidStateSource(source);

    expect(source).toContain("A --> Done: approve");
    expect(reparsed?.transitions.at(-1)).toMatchObject({
      from: "A",
      label: "approve",
      to: "Done",
    });
  });

  test("roundtrips gantt section, task and date edits through typed commands", () => {
    const model = parseMermaidGanttSource(
      "gantt\n  title Release\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :done, design, 2026-01-01, 2d\n  Ship :active, ship, after design, 1d\n",
    )!;
    const section = model.sections[0]!;
    const design = model.tasks.find((task) => task.id === "design")!;
    const renamedSection = applyGanttCommand({
      command: {
        sectionId: section.id,
        title: "Implementation",
        type: "section.rename",
      },
      model,
      readonly: false,
    });
    expect(renamedSection.changed).toBe(true);
    const renamedTask = applyGanttCommand({
      command: {
        label: "UX Design",
        taskId: design.recordId,
        type: "task.rename",
      },
      model: renamedSection.model,
      readonly: false,
    });
    const movedTask = applyGanttCommand({
      command: {
        deltaMs: 2 * 86_400_000,
        taskId: renamedTask.model.tasks.find((task) => task.id === "design")!
          .recordId,
        type: "task.move",
      },
      model: renamedTask.model,
      readonly: false,
    });
    const source = movedTask.source;
    const parsed = parseMermaidGanttSource(source);

    expect(source).toContain("section Implementation");
    expect(source).toContain("UX Design");
    expect(source).toContain("2026-01-03");
    expect(source).toContain("after design");
    expect(parsed?.tasks.find((task) => task.id === "design")?.start).toBe(
      "2026-01-03",
    );
    expect(parsed?.tasks.find((task) => task.id === "ship")?.afterIds).toEqual([
      "design",
    ]);
  });

  test("adds gantt dependencies and changes duration through typed commands", () => {
    const model = parseMermaidGanttSource(
      "gantt\n  title Build Plan\n  dateFormat YYYY-MM-DD\n  section Work\n  Design :a1, 2026-01-01, 3d\n  Build :b1, 2026-01-05, 5d\n",
    )!;
    const design = model.tasks.find((task) => task.id === "a1")!;
    const build = model.tasks.find((task) => task.id === "b1")!;
    const linked = applyGanttCommand({
      command: {
        fromTaskId: design.recordId,
        toTaskId: build.recordId,
        type: "dependency.create",
      },
      model,
      readonly: false,
    });
    expect(linked.changed).toBe(true);
    const resized = applyGanttCommand({
      command: {
        afterIds: ["a1"],
        duration: "7d",
        end: "",
        mode: "after",
        start: "after a1",
        taskId: build.recordId,
        type: "schedule.set",
        untilIds: [],
      },
      model: linked.model,
      readonly: false,
    });
    const source = resized.changed ? resized.source : linked.source;
    const reparsed = parseMermaidGanttSource(source);

    expect(source).toContain("after a1");
    expect(reparsed?.tasks.find((task) => task.id === "b1")).toMatchObject({
      duration: "7d",
    });
  });

  test("roundtrips gitGraph commit edits without reordering operations", () => {
    const model = parseMermaidGitGraphSource(
      'gitGraph\n  commit id:"A"\n  branch feature\n  checkout feature\n  commit id:"B"\n  checkout main\n  merge feature\n',
    )!;
    const key = model.derivedGraph!.occurrences.find(
      (c) => c.sourceId === "B",
    )!.sourceKey;
    const changed = editGitGraphCommit(model, key, { message: "B2" });
    const source = changed.source;
    const parsed = parseMermaidGitGraphSource(source);

    expect(source).toContain('commit id:"A"');
    expect(source).toContain('commit id:"B" msg:"B2"');
    expect(source).toContain("merge feature");
    expect(parsed?.commits.find((commit) => commit.id === "B")?.message).toBe(
      "B2",
    );
    expect(parsed?.commits.find((commit) => commit.id === "B")?.branchId).toBe(
      "feature",
    );
  });

  test("adds gitGraph merges through the semantic visual model", () => {
    const model = parseMermaidGitGraphSource(
      'gitGraph\n  commit id:"A"\n  branch feature\n  checkout feature\n  commit id:"B"\n',
    )!;
    const branch = model.branches.find((b) => b.id === "feature")!;
    const checkout = createGitGraphCheckout(
      model,
      { sourceKey: null, position: "after" },
      { sourceKey: model.branches[0]!.sourceKey! },
    );
    const merged = createGitGraphMerge(
      checkout.model,
      { sourceKey: null, position: "after" },
      { sourceKey: branch.sourceKey! },
      { id: "", type: null, tags: [] },
    );
    const source = merged.source;
    const parsed = parseMermaidGitGraphSource(source);

    expect(source).toContain("checkout main\n  merge feature");
    expect(parsed?.operations.at(-1)).toMatchObject({
      branchId: "main",
      kind: "merge",
      targetBranchId: "feature",
    });
  });

  test("routes journey diagrams through the Core Journey Facade host", () => {
    const host = renderVisualEditorForSource(
      "journey\n  title Onboarding\n  section Discover\n    Read docs: 4: User, Admin\n    Invite team: 3: Admin\n",
    );

    expect(host.querySelector(".myoxus-mermaid-journey-editor")).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-journey-section")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-journey-step")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(
      resolveMermaidFamilyRuntime(
        "journey\n  section Discover\n    Read docs: 4: User, Admin\n",
      ),
    ).toMatchObject({ capabilities: { kind: "structured" }, kind: "resolved" });
  });

  test("roundtrips journey section, step, score and actor edits through semantic model", () => {
    const model = parseMermaidJourneySource(
      "journey\n  title Onboarding\n  section Discover\n    Read docs: 4: User, Admin\n",
    )!;
    const renamedSection = renameMermaidJourneySection(
      model,
      model.sections[0].id,
      "Adopt",
    );
    const renamedStep = renameMermaidJourneyStep(
      renamedSection,
      model.steps[0].id,
      "Publish playbook",
    );
    const scoredStep = setMermaidJourneyStepScore(
      renamedStep,
      model.steps[0].id,
      5,
    );
    const actorStep = setMermaidJourneyStepActors(
      scoredStep,
      model.steps[0].id,
      ["Owner", "Editor"],
    );
    const source = generateMermaidJourneySource(actorStep);
    const parsed = parseMermaidJourneySource(source);

    expect(source).toContain("section Adopt");
    expect(source).toContain("Publish playbook: 5: Owner, Editor");
    expect(parsed?.steps[0]).toMatchObject({
      actors: ["Owner", "Editor"],
      label: "Publish playbook",
      score: 5,
    });
  });

  test("moves journey steps between sections through the semantic visual model", () => {
    const model = parseMermaidJourneySource(
      "journey\n  title Onboarding\n  section Discover\n    Read docs: 4: User\n  section Adopt\n    Publish: 3: Admin\n",
    )!;
    const moved = moveMermaidJourneyStepToSection(
      model,
      model.steps[0].id,
      model.sections[1].id,
    );
    const source = generateMermaidJourneySource(moved);
    const parsed = parseMermaidJourneySource(source, moved);

    expect(source).toContain(
      "section Adopt\n    Publish: 3: Admin\n    Read docs: 4: User",
    );
    expect(
      parsed?.steps.find((step) => step.label === "Read docs"),
    ).toMatchObject({
      sectionId: model.sections[1].id,
    });
  });

  test("routes representable kanban diagrams through the shared board facade host", () => {
    const source =
      "kanban\n  todo[To Do]\n    t1[Draft spec]\n  done[Done]\n    t2[Reviewed]\n";
    const host = renderVisualEditorForSource(source);
    const parsed = parseMermaidSourceToGfxVisualModel(source);

    expect(parsed.diagramType).toBe("kanban");
    expect(parsed.model).toBeNull();
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-kanban-column")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-kanban-card")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(host.textContent).not.toContain("Source-first diagram");
  });

  test("keeps kanban source bytes, identity and comment ownership through edits and stale targets", () => {
    const owned =
      '    %% card comment\r\n    ["Same"]@{\r\n      foreign:\r\n        count: 7\r\n        note: "retained"\r\n    }\r\n';
    const source =
      '---\r\nconfig: {kanban: {sectionWidth: 200, retained: "yes"}}\r\n---\r\nKANBAN\r\n  todo[To Do]\r\n' +
      owned +
      "\r\n%% position\r\n  done[Done]\r\n    t2((Same))";
    const model = parseMermaidKanbanSource(source)!;
    const cardId = model.cards[0].id;
    const destination = model.columns[1].id;
    expect(model.cards.map((card) => card.label)).toEqual(["Same", "Same"]);
    expect(model.cards[0].explicitId).toBeUndefined();
    const renamed = applyKanbanCommand(model, {
      type: "rename",
      id: cardId,
      label: "Changed",
    });
    expect(renamed.source).toBe(source.replace('["Same"]', '["Changed"]'));
    const edited = applyKanbanCommand(renamed.model, {
      type: "metadata",
      id: cardId,
      field: "foreign",
      value: { count: 8, note: "retained" },
    });
    expect(edited.source).toBe(renamed.source.replace("count: 7", "count: 8"));
    const moved = applyKanbanCommand(edited.model, {
      type: "move-card",
      id: cardId,
      columnId: destination,
    });
    expect(moved.reason).toBe("applied");
    const changedOwned = owned
      .replace('["Same"]', '["Changed"]')
      .replace("count: 7", "count: 8");
    expect(moved.source).toBe(
      edited.source.replace(changedOwned, "") +
        "\r\n" +
        changedOwned.slice(0, -2),
    );
    expect(moved.model.cards.find((card) => card.id === cardId)?.columnId).toBe(
      destination,
    );
    expect(
      moved.model.comments.find((comment) => comment.text === "card comment")
        ?.anchorId,
    ).toBe(cardId);
    expect(
      moved.model.comments.find((comment) => comment.text === "position")
        ?.affinity,
    ).toBe("position");
    const reparse = parseMermaidKanbanSource(moved.source, moved.model)!;
    expect(reparse.cards.map((card) => card.id)).toEqual(
      moved.model.cards.map((card) => card.id),
    );
    const command = { type: "rename" as const, id: cardId, label: "Cancelled" };
    expect(
      applyKanbanCommand(reparse, command, { intent: "cancel" }).source,
    ).toBe(moved.source);
    expect(
      applyKanbanCommand(reparse, command, { readonly: true }).source,
    ).toBe(moved.source);
    const latest = parseMermaidKanbanSource(
      moved.source.replace("done[Done]", "done[External]"),
      reparse,
    )!;
    const stale = applyKanbanCommands(
      latest,
      [command, { type: "move-card", id: cardId, columnId: destination }],
      { baseSource: moved.source },
    );
    expect(stale.reason).toBe("conflict");
    expect(stale.source).toBe(latest.sourceDocument.source);
    const partialSource = latest.sourceDocument.source.replace(
      "t2((Same))",
      "t2((Same))@{shape: 123}",
    );
    const partial = parseMermaidKanbanSource(partialSource, latest)!;
    const invalidCard = partial.cards.find((card) => card.explicitId === "t2")!;
    expect(invalidCard.writable).toBe(false);
    expect(
      applyKanbanCommand(partial, {
        type: "rename",
        id: invalidCard.id,
        label: "Blocked",
      }).source,
    ).toBe(partialSource);
    const independent = applyKanbanCommand(partial, {
      type: "rename",
      id: partial.columns[0].id,
      label: "Independent",
    });
    expect(independent.reason).toBe("applied");
    expect(independent.source).toBe(
      partialSource.replace("todo[To Do]", "todo[Independent]"),
    );
  });

  test("roundtrips mindmap labels, hierarchy and shape edits through semantic model", () => {
    const model = parseMermaidMindmapSource(
      "mindmap\n  root((Product))\n    Discovery\n      [Interview]\n",
    )!;
    const renamedRoot = renameMermaidMindmapNode(
      model,
      model.nodes[0].id,
      "Workspace",
    );
    const shapedChild = setMermaidMindmapNodeShape(
      renamedRoot,
      model.nodes[1].id,
      "square",
    );
    const source = generateMermaidMindmapSource(shapedChild);
    const parsed = parseMermaidMindmapSource(source)!;

    expect(source).toContain("root((Workspace))");
    expect(source).toContain("  [Discovery]");
    expect(source).toContain("    [Interview]");
    expect(parsed.nodes[2]).toMatchObject({
      depth: 2,
      label: "Interview",
      parentId: parsed.nodes[1].id,
      shape: "square",
    });
  });

  test("patches only owning mindmap ranges and carries moved bindings", () => {
    const source =
      '---\r\ntitle: Retained\r\n---\r\nmindmap\r\nRoot((Root))\r\n\tFoo["Same"]\r\n::icon(missing)\r\n  %% follows Foo\r\n\tBar["Same"]\r\n\t   Leaf\r\n\tOther';
    const model = parseMermaidMindmapSource(source)!;
    const [root, foo, bar, leaf] = model.nodes;
    const renamed = editMindmapNode(model, foo.sourceKey, { label: "Changed" });
    expect(renamed.source).toBe(
      source.replace('Foo["Same"]', 'Foo["Changed"]'),
    );
    expect(renamed.model.nodes.map((n) => n.sourceKey)).toEqual(
      model.nodes.map((n) => n.sourceKey),
    );
    const shaped = editMindmapNode(renamed.model, foo.sourceKey, {
      shape: "cloud",
    });
    expect(shaped.source).toBe(
      renamed.source.replace('Foo["Changed"]', 'Foo)"Changed"('),
    );
    const moved = moveMindmapSubtree(
      shaped.model,
      foo.sourceKey,
      bar.sourceKey,
      leaf.sourceKey,
    );
    expect(moved.status).toBe("changed");
    const chunk = '\tFoo)"Changed"(\r\n::icon(missing)\r\n  %% follows Foo\r\n';
    expect(moved.source).toBe(
      shaped.source
        .replace(chunk, "")
        .replace("\t   Leaf", chunk.replace("\tFoo", "\t   Foo") + "\t   Leaf"),
    );
    expect(
      new Set(moved.model.sourceDocument.records.map((r) => r.sourceKey)),
    ).toEqual(new Set(model.sourceDocument.records.map((r) => r.sourceKey)));
    expect(
      moveMindmapSubtree(moved.model, bar.sourceKey, foo.sourceKey).source,
    ).toBe(moved.source);
    expect(
      editMindmapNode(
        model,
        foo.sourceKey,
        { label: "Cancelled" },
        { intent: "cancel" },
      ).source,
    ).toBe(source);
    expect(
      editMindmapNode(
        model,
        foo.sourceKey,
        { label: "Readonly" },
        { readonly: true },
      ).source,
    ).toBe(source);
    expect(
      editMindmapNode(
        model,
        foo.sourceKey,
        { label: "Stale" },
        { baseSource: "old" },
      ).source,
    ).toBe(source);
    expect(
      editMindmapNode(model, foo.sourceKey, { label: foo.label }).source,
    ).toBe(source);
    const added = addMindmapNode(moved.model, "C(v1)", bar.sourceKey);
    expect(
      added.model.nodes.find((n) => n.sourceKey === added.selection)?.label,
    ).toBe("C(v1)");
    expect(deleteMindmapSubtree(added.model, added.selection!).source).toBe(
      moved.source,
    );
    const visual = parseMermaidSourceToGfxVisualModel(source).model!;
    visual.nodes.find((n) => n.label === "Other")!.label = "Projected";
    expect(generateMermaidSourceFromGfxVisualModel(source, visual)).toBe(
      source,
    );
    const other = model.nodes.find((node) => node.label === "Other")!;
    expect(
      editMindmapNode(model, other.sourceKey, { label: "Projected" }).source,
    ).toBe(source.replace("Other", "Projected"));
    const rootVisual = parseMermaidSourceToGfxVisualModel(source).model!;
    rootVisual.nodes = rootVisual.nodes.filter((n) => n.id !== root.sourceKey);
    rootVisual.edges = rootVisual.edges.filter(
      (e) => e.source !== root.sourceKey && e.target !== root.sourceKey,
    );
    expect(generateMermaidSourceFromGfxVisualModel(source, rootVisual)).toBe(
      source,
    );
    const emptied = deleteMindmapSubtree(model, root.sourceKey);
    expect(emptied.changed).toBe(true);
    expect(emptied.model.nodes).toEqual([]);
    expect(emptied.source).toBe(
      source.slice(
        0,
        model.sourceDocument.records.find(
          (record) => record.sourceKey === root.sourceKey,
        )!.range.start,
      ),
    );
  });

  test("roundtrips requirement risk and relationship kind edits through semantic model", () => {
    const model = parseMermaidRequirementSource(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Must publish diagrams\n    risk: high\n    verifymethod: test\n  }\n  element ui {\n    type: userInterface\n    docref: web\n  }\n  req1 - satisfies -> ui\n",
    )!;
    const lowerRisk = setMermaidRequirementRisk(model, "req1", "medium");
    const traced = renameMermaidRequirementRelation(
      lowerRisk,
      model.relations[0].id,
      "verifies",
    );
    const source = generateMermaidRequirementSource(traced);
    const parsed = parseMermaidRequirementSource(source);

    expect(source).toContain("risk: medium");
    expect(source).toContain("req1 - verifies -> ui");
    expect(parsed?.requirements[0].risk).toBe("medium");
    expect(parsed?.relations[0].kind).toBe("verifies");
  });

  test("adds requirement relations through the semantic visual model", () => {
    const model = parseMermaidRequirementSource(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Must publish diagrams\n    risk: high\n    verifymethod: test\n  }\n  element ui {\n    type: userInterface\n    docref: web\n  }\n",
    )!;
    const connected = addMermaidRequirementRelation(
      model,
      "req1",
      "ui",
      "satisfies",
    );
    const source = generateMermaidRequirementSource(connected);
    const parsed = parseMermaidRequirementSource(source);

    expect(source).toContain("req1 - satisfies -> ui");
    expect(parsed?.relations[0]).toMatchObject({
      from: "req1",
      kind: "satisfies",
      to: "ui",
    });
  });

  test("roundtrips pie slice label and value edits through semantic model", () => {
    const model = parseMermaidPieSource(
      'pie showData\n  title Work\n  "Done" : 4\n  "Open" : 2\n',
    )!;
    const renamed = applyMermaidPieSourceCommand({
      command: {
        label: "Closed",
        sliceId: model.slices[0].id,
        type: "slice.rename",
      },
      previousModel: model,
      source: model.sourceDocument.source,
    });
    const renamedSliceId =
      renamed.selectionAfter.kind === "slice"
        ? renamed.selectionAfter.id
        : model.slices[0].id;
    const changed = applyMermaidPieSourceCommand({
      command: {
        sliceId: renamedSliceId,
        type: "slice.value",
        value: 5,
      },
      previousModel: renamed.model ?? undefined,
      source: renamed.source,
    });
    const source = changed.source;
    const parsed = parseMermaidPieSource(source);

    expect(source).toContain('"Closed" : 5');
    expect(parsed?.slices[0]).toMatchObject({
      label: "Closed",
      value: 5,
    });
    expect(parsed?.showData).toBe(true);
  });

  test("promotes the preserved duplicate after deleting the effective pie slice", () => {
    const model = parseMermaidPieSource(
      'pie\n  "Shared" : 4\n  "Shared" : 2 %% preserved conflict\n  "Open" : 1\n',
    )!;
    const deleted = applyMermaidPieSourceCommand({
      command: {
        sliceId: model.slices[0].id,
        type: "slice.delete",
      },
      previousModel: model,
      source: model.sourceDocument.source,
    });
    const parsed = parseMermaidPieSource(deleted.source);

    expect(deleted.changed).toBe(true);
    expect(deleted.source).not.toContain('"Shared" : 4');
    expect(deleted.source).toContain('"Shared" : 2 %% preserved conflict');
    expect(parsed?.slices.map(({ label, value }) => [label, value])).toEqual([
      ["Shared", 2],
      ["Open", 1],
    ]);
    expect(parsed?.conflicts).toEqual([]);
  });

  test("patches duplicate quoted Sankey records without rewriting surrounding source", () => {
    const source = [
      "---",
      "title: Flow",
      "config:",
      "  sankey: { nodeAlignment: right, showValues: true }",
      "---",
      "sankey-beta",
      "%% attached comment",
      '"Source, ""A""","Target',
      'Line",2',
      '"Source, ""A""","Target',
      'Line",2',
      "Broken,Target,-1",
      "",
    ].join("\r\n");
    const model = parseSankeySource(source)!;
    const duplicateIds = model.links.slice(0, 2).map(({ id }) => id);
    const sourceNode = model.nodes.find(
      ({ label }) => label === 'Source, "A"',
    )!;

    expect(new Set(duplicateIds).size).toBe(2);
    expect(model.configOverrides).toEqual(["nodeAlignment", "showValues"]);
    const changed = applyMermaidSankeyFamilySourceCommand({
      model,
      source,
      readonly: false,
      command: [
        {
          type: "node.rename",
          id: sourceNode.id,
          label: "Input, Primary",
        },
        { type: "link.value", id: duplicateIds[0], value: 5 },
      ],
    });

    expect(changed.changed).toBe(true);
    expect(changed.source).toContain(
      '%% attached comment\r\n"Input, Primary","Target\r\nLine",5',
    );
    expect(changed.source).toContain(
      '"Input, Primary","Target\r\nLine",2\r\nBroken,Target,-1',
    );
    expect(changed.source.slice(0, changed.source.indexOf("sankey-beta"))).toBe(
      source.slice(0, source.indexOf("sankey-beta")),
    );
    expect(
      changed.model.nodes.find((node) => node.id === sourceNode.id)?.label,
    ).toBe("Input, Primary");
    expect(changed.model.links.slice(0, 2).map(({ id }) => id)).toEqual(
      duplicateIds,
    );
    expect(changed.model.links[0].value).toBe(5);
    expect(changed.model.links[1].value).toBe(2);
  });

  test("repairs one invalid Sankey record without global cycle or standalone-node gates", () => {
    const source =
      "sankey\nA,B,1\nB,A,2\nC,D,-1\n%% trailing diagram comment\n";
    const model = parseSankeySource(source)!;
    const invalid = model.links[2];
    const repaired = applyMermaidSankeyFamilySourceCommand({
      model,
      source,
      readonly: false,
      command: { type: "link.value", id: invalid.id, value: 0 },
    });

    expect(repaired.changed).toBe(true);
    expect(repaired.source).toBe(
      "sankey\nA,B,1\nB,A,2\nC,D,0\n%% trailing diagram comment\n",
    );
    expect(
      repaired.model.diagnostics.filter(({ code }) => code === "cycle"),
    ).toHaveLength(2);
    expect(
      repaired.model.diagnostics.some(({ code }) => code === "negative-value"),
    ).toBe(false);
    expect(repaired.model.nodes.map(({ label }) => label).sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);

    const rejected = applyMermaidSankeyFamilySourceCommand({
      model: repaired.model,
      source: repaired.source,
      readonly: false,
      command: {
        type: "link.add",
        source: "Orphan",
        target: "Orphan",
        value: 1,
      },
    });
    expect(rejected).toMatchObject({ changed: false, source: repaired.source });
    expect(rejected.model.nodes.some(({ label }) => label === "Orphan")).toBe(
      false,
    );

    const configured = parseSankeySource(
      '%%{init: {"sankey":{"nodeAlignment":"right"}}}%%\nsankey\nA,B,1\n',
    )!;
    const invalidConfig = parseSankeySource(
      '%%{init: {"sankey":{"nodeAlignment":"diagonal"}}}%%\nsankey\nA,B,1\n',
      configured,
    )!;
    expect(invalidConfig.config.nodeAlignment).toBe("right");
    expect(invalidConfig.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "config",
          configField: "nodeAlignment",
        }),
      ]),
    );
  });

  test("roundtrips timeline period and event edits through semantic model", () => {
    const model = parseMermaidTimelineSource(
      "timeline\n  title Releases\n  section Web\n    2026 : Mermaid canvas : Export\n",
    )!;
    const renamedPeriod = applyTimelineCommand(
      model,
      {
        type: "rename",
        anchor: { kind: "period", id: model.periods[0].id },
        label: "2027",
      },
      { baseSource: model.sourceDocument.source, readonly: false },
    );
    const renamedEvent = applyTimelineCommand(
      renamedPeriod.model,
      {
        type: "rename",
        anchor: { kind: "event", id: model.events[0].id },
        label: "Visual canvas",
      },
      { baseSource: renamedPeriod.source, readonly: false },
    );
    const source = renamedEvent.source;
    const parsed = parseMermaidTimelineSource(source);

    expect(source).toContain("2027");
    expect(source).toContain(": Visual canvas");
    expect(source).toContain(": Export");
    expect(parsed?.periods[0].label).toBe("2027");
    expect(parsed?.events[0].label).toBe("Visual canvas");
  });

  test("roundtrips treemap label and value edits through semantic model", () => {
    const model = parseTreemapSource(
      'treemap-beta\n"Root"\n  "A": 3\n  "B": 1\n',
    )!;
    const renamed = applyTreemapCommand({
      command: { type: "node.rename", id: model.nodes[1].id, label: "Alpha" },
      model,
      readonly: false,
      source: model.sourceDocument.source,
    });
    const changed = applyTreemapCommand({
      command: { type: "value.set", id: renamed.model.nodes[1].id, value: 5 },
      model: renamed.model,
      readonly: false,
      source: renamed.source,
    });
    const source = changed.source;
    const parsed = parseTreemapSource(source);

    expect(source).toContain('"Alpha": 5');
    expect(parsed?.nodes[1]).toMatchObject({
      label: "Alpha",
      value: 5,
    });
  });

  test("keeps treemap statement identity and untouched source through local edits", () => {
    const source = [
      "---",
      "title: Capacity map",
      "---",
      "treemap-beta",
      "classDef focus fill:#fff,stroke:#111;",
      '"Root"',
      '  "Same": 1:::focus',
      "",
      "  %% attached",
      '  "Same": 2',
      "",
    ].join("\r\n");
    const model = parseTreemapSource(source)!;
    const first = model.nodes[1];
    const second = model.nodes[2];
    expect(first.label).toBe(second.label);
    expect(first.id).not.toBe(second.id);
    expect(model.comments[0].anchor).toEqual({ kind: "node", id: second.id });

    const renamed = applyTreemapCommand({
      command: { type: "node.rename", id: second.id, label: "Other" },
      model,
      readonly: false,
      source,
    });
    expect(renamed.changed).toBe(true);
    expect(
      renamed.model.nodes.find((node) => node.id === second.id)?.label,
    ).toBe("Other");
    expect(
      renamed.model.nodes.find((node) => node.id === first.id)?.label,
    ).toBe("Same");
    expect(renamed.source).toContain(
      "classDef focus fill:#fff,stroke:#111;\r\n",
    );
    expect(renamed.source).toContain('  %% attached\r\n  "Other": 2');
    expect(renamed.source).toContain('  "Same": 1:::focus');
  });

  test("moves treemap subtrees with bound trivia and stable relative indentation", () => {
    const source = [
      "treemap",
      '"Root"',
      '  "Group"',
      "",
      "    %% bound",
      '    "Leaf": 2',
      '  "Target"',
      '    "Existing": 1',
      "",
    ].join("\n");
    const model = parseTreemapSource(source)!;
    const group = model.nodes.find((node) => node.label === "Group")!;
    const leaf = model.nodes.find((node) => node.label === "Leaf")!;
    const target = model.nodes.find((node) => node.label === "Target")!;
    expect(
      model.comments.find((comment) => comment.text === "bound")?.anchor,
    ).toEqual({ kind: "node", id: leaf.id });
    const moved = applyTreemapCommand({
      command: {
        type: "hierarchy.reparent",
        id: group.id,
        parentId: target.id,
      },
      model,
      readonly: false,
      source,
    });
    expect(moved.changed).toBe(true);
    expect(
      moved.model.nodes.find((node) => node.id === group.id)?.parentId,
    ).toBe(target.id);
    expect(
      moved.model.nodes.find((node) => node.id === leaf.id)?.parentId,
    ).toBe(group.id);
    expect(moved.source).toContain(
      '  "Target"\n    "Existing": 1\n    "Group"\n\n      %% bound\n      "Leaf": 2',
    );
  });

  test("reorders treemap siblings without joining statements or changing trivia", () => {
    const source =
      'treemap\n"Root"\n  "First": 1\n\n  %% keep\n  "Second": 2\n';
    const model = parseTreemapSource(source)!;
    const first = model.nodes.find((node) => node.label === "First")!;
    const second = model.nodes.find((node) => node.label === "Second")!;
    const reordered = applyTreemapCommand({
      command: {
        type: "hierarchy.reorder",
        id: second.id,
        siblingId: first.id,
        position: "before",
      },
      model,
      readonly: false,
      source,
    });

    expect(reordered.changed).toBe(true);
    expect(reordered.source).toBe(
      'treemap\n"Root"\n\n  %% keep\n  "Second": 2\n  "First": 1\n',
    );
    expect(
      reordered.model.nodes.find((node) => node.id === second.id)?.parentId,
    ).toBe(model.roots[0]);
  });

  test("patches treemap classes, comments and config without rewriting neighbors", () => {
    const source = [
      "---",
      "title: Keep me",
      "config:",
      "  treemap:",
      "    padding: 12",
      "    nodeWidth: 90",
      "---",
      "treemap",
      "classDef focus fill:#fff,stroke:#111;",
      '"Root"',
      "  %% keep comment",
      '  "Leaf": 2:::focus',
      "",
    ].join("\n");
    const model = parseTreemapSource(source)!;
    const definition = model.classDefs[0];
    const comment = model.comments[0];
    const changedClass = applyTreemapCommand({
      command: {
        type: "class.declaration.update",
        id: definition.id,
        index: 0,
        property: "fill",
        value: "#eee",
      },
      model,
      readonly: false,
      source,
    });
    const changedComment = applyTreemapCommand({
      command: {
        type: "comment.update",
        id: changedClass.model.comments.find((item) => item.id === comment.id)!
          .id,
        text: "updated comment",
      },
      model: changedClass.model,
      readonly: false,
      source: changedClass.source,
    });
    const formatted = applyTreemapCommand({
      command: {
        type: "appearance.set",
        field: "valueFormat",
        value: "$0,0",
      },
      model: changedComment.model,
      readonly: false,
      source: changedComment.source,
    });
    const reset = applyTreemapCommand({
      command: { type: "appearance.reset", field: "padding" },
      model: formatted.model,
      readonly: false,
      source: formatted.source,
    });

    expect(formatted.changed).toBe(true);
    expect(formatted.model.config.valueFormat).toBe("$0,0");
    expect(reset.changed).toBe(true);
    expect(reset.source).toContain("title: Keep me");
    expect(reset.source).toContain("    nodeWidth: 90");
    expect(reset.source).not.toContain("    padding: 12");
    expect(reset.source).toContain("classDef focus fill:#eee,stroke:#111;");
    expect(reset.source).toContain('  %% updated comment\n  "Leaf": 2:::focus');
  });

  test("isolates invalid treemap leaf descendants without blocking valid siblings", () => {
    const model = parseTreemapSource(
      'treemap\n"Root"\n  "Leaf": 2\n    "Invalid child": 1\n  "Valid": 3\n',
    )!;
    const invalid = model.nodes.find((node) => node.label === "Invalid child")!;
    const valid = model.nodes.find((node) => node.label === "Valid")!;
    expect(invalid.renderable).toBe(false);
    expect(
      model.diagnostics.find(
        (diagnostic) =>
          diagnostic.recordId === invalid.recordId &&
          diagnostic.code === "leaf-parent",
      ),
    ).toBeTruthy();
    expect(valid).toMatchObject({ renderable: true, parentId: model.roots[0] });
  });

  test("routes packet diagrams through the Core Packet Facade host", () => {
    const host = renderVisualEditorForSource(
      'packet\n  0-3: "Version"\n  4-7: "IHL"\n',
    );

    expect(host.querySelector(".myoxus-mermaid-packet-editor")).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-packet-field")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("roundtrips packet field label and range edits through semantic model", () => {
    const model = parseMermaidPacketSource('packet\n  0-3: "Version"\n')!;
    const result = applyPacketCommand(model, {
      type: "edit-field",
      fieldKey: model.fields[0].id,
      edit: { label: "Protocol", startBit: 0, endBit: 7 },
    });
    const source = result.source;
    const parsed = parseMermaidPacketSource(source);

    expect(source).toContain('0-7: "Protocol"');
    expect(parsed?.fields[0]).toMatchObject({
      endBit: 7,
      label: "Protocol",
      sourceForm: "range",
      startBit: 0,
      width: 8,
    });
  });

  test("roundtrips packet mixed count and explicit range fields without flattening syntax", () => {
    const model = parseMermaidPacketSource(
      'packet\n  +4: "Version"\n  4-7: "IHL"\n',
    )!;
    const source = model.sourceDocument.source;
    const parsed = parseMermaidPacketSource(source);

    expect(model.fields[0]).toMatchObject({
      endBit: 3,
      sourceForm: "count",
      startBit: 0,
      width: 4,
    });
    expect(source).toContain('+4: "Version"');
    expect(source).toContain('4-7: "IHL"');
    expect(parsed?.fields.map((field) => field.sourceForm)).toEqual([
      "count",
      "range",
    ]);
  });
});

describe("Dedicated Sequence family contracts", () => {
  test("keeps converted activation records independent of their former message through reconnect, reorder and delete", () => {
    const source = [
      "sequenceDiagram",
      "%% Keep this declaration boundary",
      "participant User",
      "participant API",
      "participant Queue",
      "User->>+API: Dispatch",
      "API-->>-User: Result",
      "User->>Queue: Tail",
      "",
    ].join("\r\n");
    const model = parseMermaidSequenceSource(source)!;
    const dispatch = model.messages[0];
    const tail = model.messages[2];
    const interval = model.activationIntervals[0];
    const converted = editSequenceActivation(model, interval.id, {
      participantId: "Queue",
      separate: true,
    });
    expect(converted.status).toBe("changed");
    const separate = converted.model.activationIntervals[0];
    expect(separate.id).toBe(interval.id);
    expect(converted.model.activations.every((a) => !a.embedded)).toBe(true);
    const reconnected = editSequenceMessage(converted.model, dispatch.id, {
      to: "User",
    });
    expect(reconnected.status).toBe("changed");
    expect(reconnected.source).toBe(
      converted.source.replace("User->>API: Dispatch", "User->>User: Dispatch"),
    );
    const reordered = reorderSequenceMessage(reconnected.model, dispatch.id, {
      key: tail.id,
      position: "before",
    });
    expect(reordered.status).toBe("changed");
    expect(reordered.model.messages.map((m) => m.label)).toEqual([
      "Result",
      "Dispatch",
      "Tail",
    ]);
    expect(reordered.model.activationIntervals[0]).toMatchObject({
      id: separate.id,
      startId: separate.startId,
      endId: separate.endId,
      participantId: "Queue",
    });
    expect(reordered.source.indexOf("deactivate Queue")).toBeLessThan(
      reordered.source.indexOf("User->>User: Dispatch"),
    );
    const deleted = deleteSequenceMessage(reordered.model, dispatch.id);
    expect(deleted.status).toBe("changed");
    expect(deleted.model.activationIntervals[0]).toMatchObject({
      id: separate.id,
      startId: separate.startId,
      endId: separate.endId,
      participantId: "Queue",
    });
    expect(deleted.source).toContain("%% Keep this declaration boundary\r\n");
    expect(deleted.source.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  test("wraps Sequence parsing and source generation with participants and message arrows", () => {
    const parsed = mermaidSequenceFamily.parseSource(
      "sequenceDiagram\n  actor User as Product User\n  participant API\n  User->>API: Request\n  API-->>User: Response\n",
      "sequenceDiagram",
    );
    const state = mermaidSequenceFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    expect(state.visualModel.diagramType).toBe("sequenceDiagram");
    if (state.visualModel.diagramType !== "sequenceDiagram") return;
    expect(state.visualModel.participants[0]).toMatchObject({
      id: "User",
      type: "actor",
      label: "Product User",
    });
    expect(
      state.visualModel.messages.map(({ arrow, label }) => [arrow, label]),
    ).toEqual([
      ["->>", "Request"],
      ["-->>", "Response"],
    ]);
    expect(
      mermaidSequenceFamily.applyVisualToSource(
        state.visualModel,
        parsed.source,
      ).source,
    ).toContain("User->>API: Request");
  });

  test("models Sequence notes, activations and autonumber as family-owned semantics", () => {
    const source = [
      "sequenceDiagram",
      "  autonumber",
      "  participant User",
      "  participant API",
      "  User->>API: Request",
      "  activate API",
      "  Note over User,API: Signed request",
      "  API-->>User: Response",
      "  deactivate API",
    ].join("\n");
    const parsed = mermaidSequenceFamily.parseSource(source, "sequenceDiagram");
    const state = mermaidSequenceFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "sequenceDiagram") return;

    expect(state.visualModel.autonumberLine).toBe("autonumber");
    expect(state.visualModel.notes).toEqual([
      expect.objectContaining({
        label: "Signed request",
        participantIds: ["User", "API"],
        placement: "over",
      }),
    ]);
    expect(
      state.visualModel.activations.map(({ kind, participantId }) => [
        kind,
        participantId,
      ]),
    ).toEqual([
      ["activate", "API"],
      ["deactivate", "API"],
    ]);

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    expect(
      gfx.model?.nodes
        .filter((node) => sequenceNodeGfxData(node))
        .map((node) => sequenceNodeGfxData(node)?.role),
    ).toEqual(expect.arrayContaining(["note", "activation"]));
    if (!gfx.model) return;
    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      nodes: gfx.model.nodes.map((node) =>
        sequenceNodeGfxData(node)?.role === "note"
          ? { ...node, label: "Signed request with nonce" }
          : node,
      ),
    });

    expect(editedSource).toContain("autonumber");
    expect(editedSource).toContain("activate API");
    expect(editedSource).toContain(
      "Note over User,API: Signed request with nonce",
    );
    expect(editedSource).toContain("deactivate API");
    expect(editedSource.indexOf("User->>API: Request")).toBeLessThan(
      editedSource.indexOf("activate API"),
    );
    expect(editedSource.indexOf("activate API")).toBeLessThan(
      editedSource.indexOf("Note over User,API: Signed request with nonce"),
    );
  });

  test("models Sequence control blocks as editable family-owned bands", () => {
    const source = [
      "sequenceDiagram",
      "  participant User",
      "  participant API",
      "  alt cached",
      "    API-->>User: Hit",
      "  else remote",
      "    User->>API: Request",
      "  end",
      "  loop retry",
      "    API->>User: Retry",
      "  end",
      "  par notify",
      "    API->>User: Push",
      "  and audit",
      "    API-->>User: Audit",
      "  end",
    ].join("\n");
    const parsed = mermaidSequenceFamily.parseSource(source, "sequenceDiagram");
    const state = mermaidSequenceFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "sequenceDiagram") return;

    expect(
      state.visualModel.controls.map((control) => [
        control.kind,
        control.branches.map((branch) => [branch.kind, branch.label]),
      ]),
    ).toEqual([
      [
        "alt",
        [
          ["primary", "cached"],
          ["else", "remote"],
        ],
      ],
      ["loop", [["primary", "retry"]]],
      [
        "par",
        [
          ["primary", "notify"],
          ["and", "audit"],
        ],
      ],
    ]);

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    expect(
      gfx.model?.subgraphs?.map(
        (group) => sequenceSubgraphGfxData(group)?.fragmentKind,
      ),
    ).toEqual(["alt", "loop", "par"]);
    expect(
      gfx.model?.nodes
        .filter((node) => sequenceNodeGfxData(node)?.role === "branch")
        .map((node) => node.label),
    ).toEqual(["cached", "remote", "retry", "notify", "audit"]);
    if (!gfx.model) return;

    const altBand = gfx.model.subgraphs?.find(
      (subgraph) => sequenceSubgraphGfxData(subgraph)?.fragmentKind === "alt",
    );
    const remoteBranch = gfx.model.nodes.find(
      (node) =>
        sequenceNodeGfxData(node)?.role === "branch" && node.label === "remote",
    );
    expect(altBand).toBeTruthy();
    expect(remoteBranch).toBeTruthy();
    if (!altBand || !remoteBranch) return;
    expect(remoteBranch.y).toBeGreaterThan(altBand.y);
    expect(remoteBranch.y + remoteBranch.height).toBeLessThan(
      altBand.y + altBand.height,
    );
    expect(remoteBranch.x).toBeGreaterThanOrEqual(altBand.x);
    expect(remoteBranch.x + remoteBranch.width).toBeLessThanOrEqual(
      altBand.x + altBand.width,
    );
    expect(remoteBranch.shape).toBe("rect");

    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      nodes: gfx.model.nodes.map((node) =>
        sequenceNodeGfxData(node)?.role === "branch" && node.label === "remote"
          ? {
              ...node,
              displayLabel: "else fallback remote",
              label: "fallback remote",
            }
          : node,
      ),
    });

    expect(editedSource).toContain("alt cached");
    expect(editedSource).toContain("else fallback remote");
    expect(editedSource).toContain("loop retry");
    expect(editedSource).toContain("par notify");
    expect(editedSource).toContain("and audit");
    expect(editedSource.indexOf("alt cached")).toBeLessThan(
      editedSource.indexOf("API-->>User: Hit"),
    );
    expect(editedSource.indexOf("else fallback remote")).toBeLessThan(
      editedSource.indexOf("User->>API: Request"),
    );
  });

  test("models Sequence boxes and rect backgrounds without dropping source structure", () => {
    installProjectedMermaidTestTheme();
    const source = [
      "sequenceDiagram",
      "  autonumber",
      "  box rgb(232, 240, 254) Core lane",
      "    participant User",
      "    participant API",
      "  end",
      "  rect rgba(80, 120, 220, .12)",
      "    User->>API: Request",
      "    activate API",
      "    alt cached",
      "      API-->>User: Hit",
      "    else remote",
      "      API-->>User: Miss",
      "    end",
      "    Note over User,API: Routed request",
      "    API-->>User: Response",
      "    deactivate API",
      "  end",
    ].join("\n");
    const parsed = mermaidSequenceFamily.parseSource(source, "sequenceDiagram");
    const state = mermaidSequenceFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "sequenceDiagram") return;

    expect(
      state.visualModel.backgrounds.map(
        ({ color, kind, label, participantIds }) => [
          kind,
          color,
          label,
          participantIds,
        ],
      ),
    ).toEqual([
      ["box", "rgb(232, 240, 254)", "Core lane", ["User", "API"]],
      ["rect", "rgba(80, 120, 220, .12)", "", []],
    ]);

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    expect(
      gfx.model?.subgraphs
        ?.filter((group) =>
          ["box", "rect"].includes(
            String(sequenceSubgraphGfxData(group)?.role),
          ),
        )
        .map((group) => [
          sequenceSubgraphGfxData(group)?.role,
          sequenceSubgraphGfxData(group)?.color,
          group.title,
        ]),
    ).toEqual([
      ["box", "rgb(232, 240, 254)", "Core lane"],
      ["rect", "rgba(80, 120, 220, .12)", ""],
    ]);
    if (!gfx.model) return;
    const box = gfx.model.subgraphs?.find(
      (subgraph) => sequenceSubgraphGfxData(subgraph)?.role === "box",
    );
    const rect = gfx.model.subgraphs?.find(
      (subgraph) => sequenceSubgraphGfxData(subgraph)?.role === "rect",
    );
    expect(rect?.title).toBe("");
    expect(box?.nodeIds).toEqual(
      gfx.model.nodes
        .filter(
          (node) =>
            sequenceNodeGfxData(node)?.role === "participant" &&
            !sequenceNodeGfxData(node)?.mirror,
        )
        .map((node) => node.id),
    );
    expect(
      toMermaidSubgraphElementProps(
        box!,
        new Bound(0, 0, 1000, 1000),
        sequenceGfxHooks.hooks.subgraphElementProjection(gfx.model, box!),
      ),
    ).toMatchObject({
      fillColor: "rgb(232, 240, 254)",
      textDisplay: true,
    });
    const requestEdge = gfx.model.edges.find(
      (edge) => edge.label === "Request",
    );
    const requestSource = gfx.model.nodes.find(
      (node) => node.id === requestEdge?.sourceAttachment,
    );
    const requestY =
      requestSource && requestEdge?.sourcePosition
        ? requestSource.y + requestSource.height * requestEdge.sourcePosition[1]
        : null;
    expect(requestY).not.toBeNull();
    expect(
      sequenceGfxHooks.hooks.edgeElementProjection(gfx.model, requestEdge!, 0),
    ).toMatchObject({
      color: "--myoxus-document-text-on-light-fill",
      stroke: "--myoxus-document-text-on-light-fill",
    });
    if (requestY !== null) {
      expect(rect?.y).toBeLessThan(requestY);
      expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeGreaterThan(requestY);
    }
    expect(
      toMermaidSubgraphElementProps(
        rect!,
        new Bound(0, 0, 1000, 1000),
        sequenceGfxHooks.hooks.subgraphElementProjection(gfx.model, rect!),
      ),
    ).toMatchObject({
      fillColor: "rgba(80, 120, 220, .12)",
      textDisplay: true,
    });
    const apiLifeline = gfx.model.nodes.find(
      (node) =>
        sequenceNodeGfxData(node)?.role === "lifeline" &&
        sequenceNodeGfxData(node)?.participantId === "API",
    );
    const apiActivation = gfx.model.nodes.find(
      (node) => sequenceNodeGfxData(node)?.role === "activation",
    );
    expect(apiLifeline?.width).toBeGreaterThan(0);
    expect(sequenceNodeGfxData(apiLifeline!)).toMatchObject({
      role: "lifeline",
    });
    expect(apiActivation).toMatchObject({ width: 10 });
    expect(sequenceNodeGfxData(apiActivation!)).toMatchObject({
      role: "activation",
    });
    expect(
      toMermaidShapeElementProps(
        apiLifeline!,
        new Bound(0, 0, 1000, 1000),
        undefined,
        undefined,
        sequenceGfxHooks.hooks.nodeElementProjection(gfx.model, apiLifeline!),
      ),
    ).toMatchObject({
      mermaidNodeSelectable: true,
      textDisplay: false,
      strokeColor: "--myoxus-document-text-on-light-fill",
    });
    expect(
      toMermaidShapeElementProps(
        apiActivation!,
        new Bound(0, 0, 1000, 1000),
        undefined,
        undefined,
        sequenceGfxHooks.hooks.nodeElementProjection(gfx.model, apiActivation!),
      ),
    ).toMatchObject({
      mermaidNodeSelectable: true,
      textDisplay: false,
    });

    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      subgraphs: gfx.model.subgraphs?.map((subgraph) =>
        sequenceSubgraphGfxData(subgraph)?.role === "box"
          ? { ...subgraph, title: "Core services" }
          : subgraph,
      ),
    });

    expect(editedSource).toContain("box rgb(232, 240, 254) Core services");
    expect(editedSource).toContain("rect rgba(80, 120, 220, .12)");
    expect(editedSource).toContain("autonumber");
    expect(editedSource).toContain("alt cached");
    expect(editedSource).toContain("else remote");
    expect(editedSource).toContain("deactivate API");
    expect(editedSource.indexOf("rect rgba")).toBeLessThan(
      editedSource.indexOf("User->>API: Request"),
    );
    expect(editedSource.indexOf("Note over User,API")).toBeLessThan(
      editedSource.indexOf("deactivate API"),
    );
    expect(editedSource.indexOf("deactivate API")).toBeLessThan(
      editedSource.lastIndexOf("end"),
    );
  });

  test("keeps complex State/Sequence visual bounds compact enough for stable Page and Edgeless review", () => {
    const source = [
      "sequenceDiagram",
      "  autonumber",
      "  box rgb(232, 240, 254) Core lane",
      "    participant User",
      "    participant API",
      "  end",
      "  rect rgba(80, 120, 220, .12)",
      "    User->>API: Request",
      "    activate API",
      "    alt cached",
      "      API-->>User: Cached response",
      "    else queued",
      "      API-->>User: Remote response",
      "    end",
      "    Note over User,API: Signed request",
      "    API-->>User: Response",
      "    deactivate API",
      "  end",
    ].join("\n");
    const gfx = parseMermaidSourceToGfxVisualModel(source);
    expect(gfx.model?.diagramType).toBe("sequenceDiagram");
    if (!gfx.model) return;

    const visualItems = [
      ...gfx.model.nodes,
      ...(gfx.model.subgraphs ?? []).map(({ height, width, x, y }) => ({
        height,
        width,
        x,
        y,
      })),
    ];
    const maxY = Math.max(...visualItems.map((item) => item.y + item.height));
    const note = gfx.model.nodes.find(
      (node) => sequenceNodeGfxData(node)?.role === "note",
    );
    const activation = gfx.model.nodes.find(
      (node) => sequenceNodeGfxData(node)?.role === "activation",
    );

    expect(maxY).toBeLessThan(1200);
    expect(note?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(800);
    expect(
      sequenceGfxHooks.hooks.nodeElementProjection(gfx.model, activation!),
    ).toMatchObject({ textDisplay: false });
    expect(sequenceNodeGfxData(activation!)).toMatchObject({
      role: "activation",
    });
  });

  test("keeps unsupported Sequence branch forms source-only instead of flattening them", () => {
    const invalidLoopBranch = mermaidSequenceFamily.toVisualModel(
      mermaidSequenceFamily.parseSource(
        "sequenceDiagram\n  participant User\n  participant API\n  loop retry\n    User->>API: Request\n  else fallback\n    API-->>User: Response\n  end\n",
        "sequenceDiagram",
      ),
    );

    expect(invalidLoopBranch.kind).toBe("source-only");
  });
});

describe("GitGraph ordered Source ownership", () => {
  test("keeps vertical captions clear of each other and their rails without changing bindings", () => {
    const source = `gitGraph LR:
  commit id:"bootstrap" msg:"Initial workspace shell" tag:"v0.1.0"
  branch feature
  commit id:"visual-editor" msg:"Build the direct visual editor" tag:"editor"
  branch bugfix
  commit id:"sync-fix" msg:"Prevent source drift during collaboration" tag:"hotfix"
  checkout feature
  commit id:"ux-polish" msg:"Polish long labels without giant cards" tag:"ux"
  checkout main
  merge feature id:"merge-editor" tag:"release"
  cherry-pick id:"sync-fix" tag:"backport"
  commit id:"release-notes" msg:"Publish release documentation" tag:"docs" tag:"stable"
`;
    const initialModel = resolveMermaidGitGraphSource(source).model!;
    const initial = gitGraphModelToVisual(initialModel);
    for (const direction of ["TB", "BT"] as const) {
      const orientedSource = source.replace(
        "gitGraph LR:",
        `gitGraph ${direction}:`,
      );
      const model = editGitGraphConfig(initialModel, {}, direction).model;
      const projection = gitGraphModelToVisual(model);
      expect(projection.nodes.map((n) => n.id)).toEqual(
        initial.nodes.map((n) => n.id),
      );
      expect(model.sourceDocument!.source).toBe(orientedSource);
      const captions = projection.nodes.filter((n) =>
        ["id", "message", "tag"].includes(gitGraphBinding(n)?.role ?? ""),
      );
      const overlaps = (a: MermaidVisualNode, b: MermaidVisualNode) =>
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      for (const [index, caption] of captions.entries()) {
        expect(
          captions.slice(index + 1).filter((other) => overlaps(caption, other)),
        ).toEqual([]);
        expect(
          projection.nodes.filter(
            (n) =>
              ["rail", "commit"].includes(gitGraphBinding(n)?.role ?? "") &&
              overlaps(caption, n),
          ),
        ).toEqual([]);
      }
    }
  });

  test("reports every statement blocked after an invalid GitGraph reorder without writing", () => {
    const source =
      'gitGraph\ncommit id:"A"\nbranch feature\ncommit id:"B"\ncheckout main\nmerge feature id:"M"\ncherry-pick id:"B"\ncommit id:"C"\n';
    const model = resolveMermaidGitGraphSource(source).model!;
    const records = model.sourceDocument!.records;
    const branch = records.find((r) => r.kind === "branch")!;
    const result = moveGitGraphStatements(model, [branch.sourceKey], {
      sourceKey: null,
      position: "after",
    });
    expect(result.status).toBe("rejected");
    expect(result.source).toBe(source);
    expect(result.model).toBe(model);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "gitgraph.branch.missing" }),
    );
    const failure = result.diagnostics.find(
      (d) => d.code === "gitgraph.branch.missing",
    )!;
    expect(
      result.diagnosticSource?.slice(failure.range.start, failure.range.end),
    ).toBe("feature");
    expect(result.diagnosticSource?.split("\n")[failure.range.line - 1]).toBe(
      'merge feature id:"M"',
    );
    expect(
      result.impact.filter((i) => "blockedByLine" in i).map((i) => i.sourceKey),
    ).toEqual(
      records
        .filter((r) => r === branch || r.range.line >= 6)
        .map((r) => r.sourceKey),
    );
    expect(result.impact.filter((i) => "blockedByLine" in i)).toEqual(
      expect.arrayContaining([expect.objectContaining({ blockedByLine: 5 })]),
    );
  });
  test("patches only the effective message lexeme and retains record and attribute bindings", () => {
    const source =
      "gitGraph LR:\r\n  %% before\r\n  commit id:'A' msg:\"shadow\" msg:'old' tag:\"\" tag:'tag'\r\n\r\n  commit\r\n";
    const model = resolveMermaidGitGraphSource(source).model!;
    const record = model.sourceDocument!.records.find(
      (r) => r.kind === "commit",
    )!;
    const result = editGitGraphCommit(model, record.sourceKey, {
      message: "new",
    });
    expect(result.status).toBe("changed");
    expect(result.source).toBe(source.replace("msg:'old'", "msg:'new'"));
    expect(
      result.model.sourceDocument!.records.map((r) => r.sourceKey),
    ).toEqual(model.sourceDocument!.records.map((r) => r.sourceKey));
    expect(
      result.model
        .sourceDocument!.records.find((r) => r.sourceKey === record.sourceKey)!
        .attributes.map((a) => a.sourceKey),
    ).toEqual(record.attributes.map((a) => a.sourceKey));
    const inserted = addGitGraphCommit(
      result.model,
      { sourceKey: record.sourceKey, position: "before" },
      { id: "Inserted", message: "", type: "NORMAL", tags: [] },
    );
    expect(inserted.status).toBe("changed");
    expect(inserted.source.indexOf('commit id:"Inserted"')).toBeLessThan(
      inserted.source.indexOf("%% before"),
    );
    const comment = model.sourceDocument!.records.find(
      (r) => r.kind === "comment",
    )!;
    expect(
      inserted.model.sourceDocument!.records.find(
        (r) => r.sourceKey === comment.sourceKey,
      )?.anchor?.sourceKey,
    ).toBe(record.sourceKey);
    const noop = editGitGraphCommit(result.model, record.sourceKey, {
      message: "new",
    });
    expect(noop.changed).toBe(false);
    expect(noop.source).toBe(result.source);
    expect(noop.model).toBe(result.model);
  });
});

describe("GitGraph registered projection", () => {
  test("requires confirmation and advances bindings when editing Cherry to an implicit source", () => {
    const source =
      "gitGraph\ncommit id:'A'\nbranch feature\ncommit\ncommit id:'B'\ncheckout main\ncherry-pick id:'B' tag:''";
    const model = resolveMermaidGitGraphSource(source).model!;
    const implicit = model.derivedGraph!.occurrences[1]!;
    const cherry = model.derivedGraph!.occurrences.at(-1)!;
    const tags = model
      .sourceDocument!.records.find((r) => r.sourceKey === cherry.sourceKey)!
      .attributes.filter((a) => a.name === "tag")
      .map((a) => ({ sourceKey: a.sourceKey, value: a.value }));
    const blocked = editGitGraphCherryPick(
      model,
      cherry.sourceKey,
      implicit.sourceKey,
      null,
      tags,
    );
    expect(blocked.status).toBe("rejected");
    expect(blocked.source).toBe(source);
    expect(blocked.diagnostics.map((d) => d.code)).toContain(
      "gitgraph.cherry.promote",
    );
    const changed = editGitGraphCherryPick(
      model,
      cherry.sourceKey,
      implicit.sourceKey,
      null,
      tags,
      true,
    );
    expect(changed.status).toBe("changed");
    expect(changed.source).toBe(
      source
        .replace("\ncommit\n", '\ncommit id:"commit-1"\n')
        .replace("cherry-pick id:'B'", "cherry-pick id:'commit-1'"),
    );
    expect(
      changed.model.sourceDocument!.records.map((r) => r.sourceKey),
    ).toEqual(model.sourceDocument!.records.map((r) => r.sourceKey));
    expect(changed.selection).toBe(cherry.sourceKey);
    expect(
      changed.model.derivedGraph!.occurrences.at(-1)!.executionParents,
    ).toEqual([
      model.derivedGraph!.occurrences[0]!.sourceKey,
      implicit.sourceKey,
    ]);
    expect(changed.model.derivedGraph!.occurrences.at(-1)!.tags).toEqual([]);
  });

  test("retains event order, branch origin, both merge parents and exact Source", () => {
    const source =
      'gitGraph\n  commit id:"Initial"\n  commit id:"Main work"\n  branch feature\n  checkout feature\n  commit id:"Feature start"\n  commit id:"Feature done" tag:"v1"\n  checkout main\n  merge feature tag:"<b title="native">tag</b>"\n';
    const gfx = parseMermaidSourceToGfxVisualModel(source).model!;
    const model = readGitGraphProjectionModel(source, gfx)!;
    expect(model.derivedGraph!.occurrences.at(-1)!.tags).toEqual([
      "<b title='native'>tag</b>",
    ]);
    const labels = new Map(
      model.derivedGraph!.occurrences.map((c) => [
        c.sourceKey,
        c.sourceId || c.kind,
      ]),
    );
    expect(model.events.map((e) => e.kind)).toEqual([
      "commit",
      "commit",
      "branch",
      "checkout",
      "commit",
      "commit",
      "checkout",
      "merge",
    ]);
    expect(
      gfx.edges
        .filter((e) => !e.id.endsWith(":origin-edge"))
        .map((e) => [labels.get(e.source), labels.get(e.target)]),
    ).toEqual([
      ["Initial", "Main work"],
      ["Main work", "Feature start"],
      ["Feature start", "Feature done"],
      ["Main work", "merge"],
      ["Feature done", "merge"],
    ]);
    expect(gfx.nodes.find((n) => n.shape === "doublecircle")).toBeDefined();
    expect(
      gfx.nodes.find((n) => gitGraphBinding(n)?.role === "tag")?.label,
    ).toBe("v1");
    expect(generateMermaidSourceFromGfxVisualModel(source, gfx)).toBe(source);
  });
});
