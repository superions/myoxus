import { describe, expect, test } from "vitest";

import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import { resolveMermaidGfxTheme } from "../../../mermaid-gfx-theme.js";

import { mermaidFlowchartFamily } from "../family.js";
import { reconcileFlowchartProjectionOwnerGeometry } from "../owner-geometry.js";
import { applyFlowchartGfxVisualToSource } from "../source-application.js";
import { canonicalizeFlowchartProjectionAfterSourceWrite } from "../projection-reconciliation.js";
import { layoutMeasuredFlowchart } from "../layout.js";
import { flowchartConnectorRoutingProjection } from "../connection-projection.js";
import {
  createMermaidGfxVisualEdge,
  reconnectMermaidGfxVisualEdge,
  resolveTypeOwnedMermaidGfxDeletionPlan,
} from "../../runtime/gfx-graph-operations.js";
import {
  flowchartNodeData,
  flowchartNodeLink,
  setFlowchartNodeLink,
  withFlowchartNodeMarkdown,
} from "../../../engine/flowchart-node.js";
import {
  applyFlowchartCreatedSubgraphMembership,
  createFlowchartGfxSubgraph,
  deleteFlowchartGfxSelection,
  reparentFlowchartGfxSubgraph,
  reorderFlowchartGfxSubgraph,
  syncFlowchartGfxSubgraphMembership,
} from "../gfx-operations.js";
import { finalizeFlowchartProjectionOwnerReadback } from "../owner-readback.js";
import {
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeStyleClass,
} from "../model-operations.js";
import {
  flowchartEdgeElementStyle,
  flowchartNodeElementStyle,
  flowchartSubgraphElementStyle,
} from "../gfx-style-projection.js";
import {
  readFlowchartTextFormat,
  setFlowchartTextFormat,
} from "../text-formatting.js";

describe("Mermaid Flowchart family module", () => {
  test("wraps the existing Flowchart parser and source generator without changing source semantics", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      "flowchart TD\n  A[Start] -->|Go| B[Done]\n",
      "flowchart",
    );
    const state = mermaidFlowchartFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    expect(state.visualModel.diagramType).toBe("flowchart");
    expect(state.visualModel.nodes.map(({ id }) => id)).toEqual(["A", "B"]);
    expect(state.visualModel.edges[0]).toMatchObject({
      label: "Go",
      source: "A",
      target: "B",
    });
    expect(
      mermaidFlowchartFamily.applyVisualToSource(
        state.visualModel,
        parsed.source,
      ).source,
    ).toContain("A[Start] --> |Go| B[Done]");
  });

  test("declares the Flowchart family inventory", () => {
    expect(mermaidFlowchartFamily.id).toBe("flowchart");
    expect(mermaidFlowchartFamily.diagramTypes).toEqual([
      "flowchart",
      "flowchart-elk",
    ]);
  });

  test("keeps normal node typography consistent and writes theme semantic roles", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      "flowchart TD\n  A[Review]\n",
      "flowchart",
    );
    const state = mermaidFlowchartFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const node = { ...state.visualModel.nodes[0]!, height: 88, width: 200 };
    const projected = flowchartNodeElementStyle(state.visualModel, node);
    const typography = resolveMermaidGfxTheme().typography;
    expect(projected.fontSize).toBe(typography.sectionFontSize);
    expect(projected.strokeColor).toBe("--myoxus-text-secondary-color");

    const wrapped = flowchartNodeElementStyle(state.visualModel, {
      ...node,
      displayLabel: "Final decision complete",
      height: 104,
      label: "Final decision complete",
      width: 150,
    });
    expect(wrapped.fontSize).toBe(projected.fontSize);

    const styled = setMermaidVisualNodeStyleClass(
      state.visualModel,
      node.id,
      "warning",
    );
    expect(styled.styleStatements).toContain(
      "classDef warning fill:rgb(255, 240, 215),stroke:rgb(190, 95, 40),color:rgb(20, 20, 20);",
    );
    expect(styled.styleStatements).toContain("class A warning;");
  });

  test("projects readable default typography for group and edge labels while preserving explicit source sizes", () => {
    const state = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(
        'flowchart TD\n  subgraph G["Review group"]\n    A[Review] -->|Pass| B[Done]\n  end\n',
        "flowchart",
      ),
    );
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    const group = state.visualModel.subgraphs?.[0];
    expect(group).toBeTruthy();
    if (!group) return;

    expect(
      flowchartSubgraphElementStyle(state.visualModel, group).fontSize,
    ).toBe(
      resolveMermaidGfxTheme().typography.fontSize * 2 -
        resolveMermaidGfxTheme().typography.minimumReadableFontSize,
    );
    expect(
      flowchartEdgeElementStyle(
        state.visualModel,
        state.visualModel.edges[0]!,
        0,
      ).fontSize,
    ).toBe(
      resolveMermaidGfxTheme().typography.fontSize * 2 -
        resolveMermaidGfxTheme().typography.minimumReadableFontSize,
    );
    expect(
      flowchartEdgeElementStyle(
        state.visualModel,
        state.visualModel.edges[0]!,
        0,
      ).stroke,
    ).toBe("--myoxus-text-secondary-color");

    const explicit = {
      ...state.visualModel,
      styleStatements: ["style G font-size:13px", "linkStyle 0 font-size:13px"],
    };
    expect(flowchartSubgraphElementStyle(explicit, group).fontSize).toBe(13);
    expect(
      flowchartEdgeElementStyle(explicit, explicit.edges[0]!, 0).fontSize,
    ).toBe(13);
  });

  test("roundtrips selected label formatting without changing shared styles or other labels", () => {
    const source =
      "flowchart TD\n  %% Retain this comment\n  subgraph G[Review]\n    A[Start] -->|Yes| B[Done]\n    A -->|No| C[Retry]\n  end\n  style A,B fill:var(--surface),font-size:18px\n  linkStyle 0,1 stroke:var(--connector),font-size:15px\n  classDef late fill:var(--later)\n  class A late\n";
    const parsed = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(source, "flowchart"),
    );
    expect(parsed.kind).toBe("editable");
    if (parsed.kind !== "editable") return;
    const targets = [
      { kind: "node" as const, editKey: "A" },
      { kind: "edge" as const, editKey: parsed.visualModel.edges[0]!.id },
      { kind: "subgraph" as const, editKey: "G" },
    ];
    const formatted = setFlowchartTextFormat(parsed.visualModel, targets, {
      fontSize: 24,
      bold: true,
      italic: true,
    });
    const recolored = setMermaidVisualEdgeStyleStatement(
      formatted,
      targets[1]!.editKey,
      "warning",
    );
    const written = applyFlowchartGfxVisualToSource(source, recolored);
    const replay = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(written, "flowchart"),
    );
    expect(replay.kind).toBe("editable");
    if (replay.kind !== "editable") return;
    expect(readFlowchartTextFormat(replay.visualModel, targets)).toEqual({
      fontSize: 24,
      bold: true,
      italic: true,
    });
    expect(
      flowchartNodeElementStyle(
        replay.visualModel,
        replay.visualModel.nodes.find((node) => node.id === "B")!,
      ),
    ).toMatchObject({ fillColor: "var(--surface)", fontSize: 18 });
    expect(
      flowchartNodeElementStyle(
        replay.visualModel,
        replay.visualModel.nodes.find((node) => node.id === "A")!,
      ),
    ).toMatchObject({ fillColor: "var(--later)" });
    expect(
      flowchartEdgeElementStyle(
        replay.visualModel,
        replay.visualModel.edges[1]!,
        1,
      ),
    ).toMatchObject({ stroke: "var(--connector)", fontSize: 15 });
    expect(written).toContain("%% Retain this comment");
  });

  test("roundtrips direct node Markdown and sanitized links and removes links with their node", () => {
    const source =
      'flowchart TD\n  A["`Review **request**`"] --> B[Done]\n  click A href "https://example.com/review" "Open review" _blank\n';
    const state = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(source, "flowchart"),
    );
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const node = state.visualModel.nodes.find(({ id }) => id === "A");
    expect(node && flowchartNodeData(node).markdown).toBe(true);
    expect(flowchartNodeLink(state.visualModel, "A")).toEqual({
      target: "blank",
      tooltip: "Open review",
      url: "https://example.com/review",
    });
    expect(
      setFlowchartNodeLink(state.visualModel, "A", "javascript:alert(1)"),
    ).toBeNull();

    const linked = setFlowchartNodeLink(
      {
        ...state.visualModel,
        nodes: state.visualModel.nodes.map((candidate) =>
          candidate.id === "A"
            ? withFlowchartNodeMarkdown(candidate, false)
            : candidate,
        ),
      },
      "A",
      "example.org/review",
    );
    expect(linked).toBeTruthy();
    if (!linked) return;
    const regenerated = applyFlowchartGfxVisualToSource(source, linked);
    expect(regenerated).toContain("A[Review **request**]");
    expect(regenerated).toContain(
      'click A href "https://example.org/review" "Open review" _blank',
    );

    const deleted = deleteFlowchartGfxSelection(linked, { nodeId: "A" });
    expect(flowchartNodeLink(deleted, "A")).toBeNull();
    expect(deleted.nodes.some(({ id }) => id === "A")).toBe(false);
    expect(deleted.edges).toHaveLength(0);
  });

  test("derives deletion confirmation from the exact type-owned mutation", () => {
    const state = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(
        [
          "flowchart TD",
          "  A[Start] --> B{Decision}",
          "  B --> C[Retry]",
          "  B --> D[Done]",
          "  A --> C",
        ].join("\n"),
        "flowchart",
      ),
    );
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const selectedEdgeId = state.visualModel.edges[3]!.id;
    const plan = resolveTypeOwnedMermaidGfxDeletionPlan(state.visualModel, {
      edgeId: selectedEdgeId,
    });

    expect(plan && [...plan.impact]).toEqual([selectedEdgeId]);
    expect(plan?.visualModel.nodes.map(({ id }) => id)).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(plan?.visualModel.edges.map(({ id }) => id)).toEqual(
      state.visualModel.edges.slice(0, 3).map(({ id }) => id),
    );
  });

  test("applies chosen ports atomically and reconnects only the moving endpoint", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      "flowchart TD\n  A{Decision}\n  B[Review]\n  C[Done]\n  C -->|Retry| C\n",
      "flowchart",
    );
    const state = mermaidFlowchartFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    expect(state.visualModel.edges[0]).toMatchObject({
      connectorMode: "curve",
      sourcePosition: [1, 0.25],
      targetPosition: [1, 0.75],
    });

    const created = createMermaidGfxVisualEdge(state.visualModel, "A", "B", {
      sourcePortId: "east",
      sourcePosition: [1, 0.5],
      targetPortId: "west",
      targetPosition: [0, 0.5],
    });
    expect(created).toMatchObject({
      source: "A",
      sourcePortId: "east",
      sourcePosition: [1, 0.5],
      target: "B",
      targetPortId: "west",
      targetPosition: [0, 0.5],
    });
    if (!created) return;

    const reconnected = reconnectMermaidGfxVisualEdge(
      state.visualModel,
      { ...created, label: "approve", linkType: "circle", style: "thick" },
      "target",
      "C",
      { portId: "north", position: [0.5, 0] },
    );
    expect(reconnected).toMatchObject({
      id: created.id,
      label: "approve",
      linkType: "circle",
      source: "A",
      sourcePortId: "east",
      sourcePosition: [1, 0.5],
      style: "thick",
      target: "C",
      targetPortId: "north",
      targetPosition: [0.5, 0],
    });
    if (!reconnected) return;

    const reparsed = mermaidFlowchartFamily.parseSource(
      applyFlowchartGfxVisualToSource(parsed.source, {
        ...state.visualModel,
        edges: [reconnected],
      }),
      "flowchart",
    ).model;
    expect(reparsed).toBeTruthy();
    if (!reparsed) return;
    expect(
      canonicalizeFlowchartProjectionAfterSourceWrite(
        reparsed,
        layoutMeasuredFlowchart({
          ...state.visualModel,
          edges: [reconnected],
        }),
      ).edges[0],
    ).toMatchObject({
      sourcePortId: "east",
      sourcePosition: [1, 0.5],
      targetPortId: "north",
      targetPosition: [0.5, 0],
    });
  });

  test("keeps the entry and grouped forward path aligned across a saved feedback flow", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      `flowchart TD
  subgraph Team ["Bearbeitung"]
    C[Unterlagen und Zuständigkeit prüfen] --> F[Entscheidung dokumentieren]
    subgraph Q ["Qualitätssicherung"]
      G[Ergebnis gemeinsam prüfen<br/>und Freigabe dokumentieren]
    end
  end
  A([Anfrage eingegangen]) --> B{Sind alle Angaben vollständig?}
  B --> |Ja| C
  B --> |Rückfrage| D[Fehlende Angaben anfordern]
  B --> |Ablehnen| E([Anfrage zurückweisen])
  D --> B
  F --> G
  G --> H([Abgeschlossen])`,
      "flowchart",
    );
    expect(parsed.model).toBeTruthy();
    if (!parsed.model) return;
    const laidOut = layoutMeasuredFlowchart(parsed.model, { fromSource: true });
    // Scheduled Source reconciliation must not eject a nested member from its
    // ancestor and then push the remaining forward path around that group.
    for (let i = 0; i < 3; i++)
      reconcileFlowchartProjectionOwnerGeometry(laidOut, parsed.model);
    const node = (id: string) => laidOut.nodes.find((item) => item.id === id)!;
    const center = (id: string) => node(id).x + node(id).width / 2;
    expect(center("A")).toBeCloseTo(center("B"));
    for (const id of ["F", "G", "H"])
      expect(center(id)).toBeCloseTo(center("C"));
    const forward = ["A", "B", "C", "F", "G", "H"].map(node);
    for (let i = 1; i < forward.length; i++)
      expect(forward[i].y).toBeGreaterThan(
        forward[i - 1].y + forward[i - 1].height,
      );
    expect(
      laidOut.subgraphs!.find((group) => group.id === "Team")!.y -
        node("B").y -
        node("B").height,
    ).toBeGreaterThanOrEqual(
      resolveMermaidGfxTheme().typography.lineHeight * 3,
    );
    expect(laidOut.edges.find((edge) => edge.source === "A")).toMatchObject({
      sourcePosition: [0.5, 1],
      targetPosition: [0.5, 0],
    });
    expect(laidOut.edges.find((edge) => edge.source === "D")).toMatchObject({
      targetPosition: [1, 0.5],
    });
    const enteringQuality = laidOut.edges.find(
      (edge) => edge.source === "F" && edge.target === "G",
    )!;
    const heading = flowchartConnectorRoutingProjection(
      laidOut,
      enteringQuality,
    ).routingObstacleRegions.Q;
    const quality = laidOut.subgraphs!.find((group) => group.id === "Q")!;
    expect(heading[3]).toBeGreaterThan(0);
    expect(quality.y + heading[3]).toBeLessThanOrEqual(
      node("G").y - flowchartSubgraphElementStyle(laidOut, quality).padding[0],
    );
  });

  test("routes dense fanout deterministically for vertical, horizontal, and ELK flowcharts", () => {
    for (const fixture of [
      {
        diagramType: "flowchart" as const,
        expectedNextPort: "north",
        expectedPorts: ["west", "south", "east"],
        source:
          "flowchart TD\n  D{Decision}\n  D --> A[Alpha]\n  D --> B[Beta]\n  D --> C[Gamma]\n",
      },
      {
        diagramType: "flowchart" as const,
        expectedNextPort: "west",
        expectedPorts: ["north", "east", "south"],
        source:
          "flowchart LR\n  D{Decision}\n  D --> A[Alpha]\n  D --> B[Beta]\n  D --> C[Gamma]\n",
      },
      {
        diagramType: "flowchart-elk" as const,
        expectedNextPort: "north",
        expectedPorts: ["west", "south", "east"],
        source:
          "flowchart-elk TD\n  D{Decision}\n  D --> A[Alpha]\n  D --> B[Beta]\n  D --> C[Gamma]\n",
      },
    ]) {
      const parsed = mermaidFlowchartFamily.parseSource(
        fixture.source,
        fixture.diagramType,
      );
      const state = mermaidFlowchartFamily.toVisualModel(parsed);
      expect(state.kind).toBe("editable");
      if (state.kind !== "editable") continue;

      const sourcePorts = state.visualModel.edges.map(
        (edge) => edge.sourcePortId,
      );
      expect(sourcePorts).toEqual(fixture.expectedPorts);
      expect(new Set(sourcePorts).size).toBe(3);
      expect(state.visualModel.edges.map((edge) => edge.connectorMode)).toEqual(
        ["orthogonal", "orthogonal", "orthogonal"],
      );
      expect(
        createMermaidGfxVisualEdge(state.visualModel, "D", "A")?.sourcePortId,
      ).toBe(fixture.expectedNextPort);

      const regenerated = mermaidFlowchartFamily.applyVisualToSource(
        state.visualModel,
        parsed.source,
      ).source;
      const reparsed = mermaidFlowchartFamily.toVisualModel(
        mermaidFlowchartFamily.parseSource(regenerated, fixture.diagramType),
      );
      expect(reparsed.kind).toBe("editable");
      if (reparsed.kind !== "editable") continue;
      expect(
        reparsed.visualModel.edges.map((edge) => edge.sourcePortId),
      ).toEqual(fixture.expectedPorts);
    }
  });

  test("expands a subgraph instead of snapping preserved member geometry", () => {
    const state = mermaidFlowchartFamily.toVisualModel(
      mermaidFlowchartFamily.parseSource(
        'flowchart TD\n  subgraph G["Review group"]\n    D{Decision}\n  end\n',
        "flowchart",
      ),
    );
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const sourceModel = structuredClone(state.visualModel);
    const preserved = structuredClone(state.visualModel);
    const decision = preserved.nodes[0];
    const subgraph = preserved.subgraphs?.[0];
    expect(decision).toBeTruthy();
    expect(subgraph).toBeTruthy();
    if (!decision || !subgraph) return;
    const intendedX = subgraph.x + subgraph.width - decision.width + 24;
    const intendedY = subgraph.y + 8;
    const previousRight = subgraph.x + subgraph.width;
    decision.x = intendedX;
    decision.y = intendedY;

    reconcileFlowchartProjectionOwnerGeometry(preserved, sourceModel);

    expect(decision.x).toBe(intendedX);
    expect(decision.y).toBe(intendedY);
    expect(subgraph.x + subgraph.width).toBeGreaterThan(previousRight);
    expect(subgraph.y).toBeLessThan(sourceModel.subgraphs![0].y);
  });

  test("anchors implicit identities and changes only owned rename ranges", () => {
    const source = [
      "---",
      'title: "Release path"',
      "---",
      "flowchart TD",
      "  %% retained source annotation",
      "  subgraph Release lane",
      "    A[Start] --> B[Review]",
      "  end",
      "  B --> C[Done]",
    ].join("\n");
    const parsed = mermaidFlowchartFamily.parseSource(source, "flowchart");
    const state = mermaidFlowchartFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const requested = structuredClone(state.visualModel);
    requested.nodes.reverse();
    requested.edges.reverse();
    const review = requested.nodes.find(({ id }) => id === "B");
    const firstEdge = requested.edges.find(
      ({ source: edgeSource, target }) => edgeSource === "A" && target === "B",
    );
    const lane = requested.subgraphs?.[0];
    expect(review).toBeTruthy();
    expect(firstEdge).toBeTruthy();
    expect(lane).toBeTruthy();
    if (!review || !firstEdge || !lane) return;
    review.label = "Reviewed";
    firstEdge.label = "approved";
    lane.title = "Approved lane";

    const nextSource = applyFlowchartGfxVisualToSource(source, requested);
    expect(nextSource).toContain("  %% retained source annotation");
    expect(nextSource).toContain('  subgraph SG1 ["Approved lane"]');
    expect(nextSource).toContain(
      "    A[Start] edge-A-B-1@--> |approved| B[Reviewed]",
    );
    expect(nextSource).toContain("  B edge-B-C-2@--> C[Done]");

    const reparsed = mermaidFlowchartFamily.parseSource(
      nextSource,
      "flowchart",
    );
    expect(reparsed.model?.nodes.map(({ id }) => id).sort()).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(reparsed.model?.edges.map(({ id }) => id).sort()).toEqual([
      "edge-A-B-1",
      "edge-B-C-2",
    ]);
    expect(reparsed.model?.subgraphs?.[0]).toMatchObject({
      id: "SG1",
      nodeIds: ["A", "B"],
      title: "Approved lane",
    });

    const geometryOnly = structuredClone(reparsed.model!);
    geometryOnly.nodes[0]!.x += 80;
    expect(applyFlowchartGfxVisualToSource(nextSource, geometryOnly)).toBe(
      nextSource,
    );

    const reparented = structuredClone(reparsed.model!);
    reparented.subgraphs![0]!.nodeIds = ["A"];
    const reparentedSource = applyFlowchartGfxVisualToSource(
      nextSource,
      reparented,
    );
    const reparsedReparented = mermaidFlowchartFamily.parseSource(
      reparentedSource,
      "flowchart",
    ).model;
    expect(reparsedReparented?.subgraphs?.[0]?.nodeIds).toEqual(["A"]);
    expect(reparsedReparented?.edges.map(({ id }) => id).sort()).toEqual([
      "edge-A-B-1",
      "edge-B-C-2",
    ]);
    expect(reparentedSource).toContain("%% retained source annotation");
  });

  test("keeps nested Flowchart structure and patches only targeted style and link ranges", () => {
    for (const header of ["graph LR", "flowchart-elk LR"]) {
      const source = [
        header,
        '  subgraph OUT ["Outer lane"]',
        "    direction TB",
        '    A@{ shape: docs, label: "`Review **request**`" } e1@o---o |paired| B[(Store)]',
        '    subgraph INNER ["Inner lane"]',
        "      direction RL",
        "      C{{Choice}} e2@<--- D([Done]) e3@-. dotted .-> E[/Retry/]",
        "    end",
        "  end",
        "  classDef bespoke fill:#fff,stroke:#111;",
        "  class A bespoke;",
        "  style B fill:#eee,stroke:#222;",
        "  linkStyle 0 stroke:#333,stroke-width:4px;",
        '  click A href "https://example.com/review" "Open review" _blank',
        "  click C runReview",
      ].join("\n");
      const parsed = mermaidFlowchartFamily.parseSource(
        source,
        header.startsWith("flowchart-elk") ? "flowchart-elk" : "flowchart",
      );
      const state = mermaidFlowchartFamily.toVisualModel(parsed);
      expect(state.kind).toBe("editable");
      if (state.kind !== "editable") continue;

      expect(state.visualModel.subgraphs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "OUT", parentId: undefined }),
          expect.objectContaining({ id: "INNER", parentId: "OUT" }),
        ]),
      );
      expect(state.visualModel.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "e1",
            sourceMarker: "circle",
            targetMarker: "circle",
          }),
          expect.objectContaining({ id: "e2", linkType: "reverse" }),
          expect.objectContaining({
            id: "e3",
            label: "dotted",
            linkType: "dotted",
          }),
        ]),
      );

      const readback = finalizeFlowchartProjectionOwnerReadback(
        {
          ...state.visualModel,
          subgraphs: state.visualModel.subgraphs?.map(
            ({ parentId: _parentId, ...subgraph }) => subgraph,
          ),
        },
        state.visualModel,
        { edges: [], nodes: [] },
      );
      expect(
        readback.subgraphs?.find(({ id }) => id === "INNER")?.parentId,
      ).toBe("OUT");

      let requested = setMermaidVisualNodeStyleClass(readback, "A", "accent");
      requested = setMermaidVisualEdgeStyleStatement(
        requested,
        "e1",
        "success",
      );
      const linked = setFlowchartNodeLink(
        requested,
        "A",
        "https://example.org/reviewed",
      );
      expect(linked).toBeTruthy();
      if (!linked) continue;
      const nextSource = applyFlowchartGfxVisualToSource(source, linked);

      expect(nextSource).toContain(
        '    A@{ shape: docs, label: "`Review **request**`" } e1@o---o |paired| B[(Store)]',
      );
      expect(nextSource).toContain(
        "      C{{Choice}} e2@<--- D([Done]) e3@-. dotted .-> E[/Retry/]",
      );
      expect(nextSource).toContain("  classDef bespoke fill:#fff,stroke:#111;");
      expect(nextSource).toContain("  style B fill:#eee,stroke:#222;");
      expect(nextSource).toContain("  class A accent;");
      expect(nextSource).toContain(
        "  linkStyle 0 stroke:rgb(30, 130, 70),stroke-width:2px;",
      );
      expect(nextSource).toContain(
        '  click A href "https://example.org/reviewed" "Open review" _blank',
      );
      expect(nextSource).toContain("  click C runReview");
      expect(
        mermaidFlowchartFamily.parseSource(
          nextSource,
          header.startsWith("flowchart-elk") ? "flowchart-elk" : "flowchart",
        ).model,
      ).toBeTruthy();
    }
  });

  test("groups only explicit ordered selections and preserves unrelated source through nested subgraph commands", () => {
    const source = [
      "flowchart TD",
      "  %% unrelated annotation",
      "  A[Alpha]",
      "  B[Beta]",
      "  C[Outside]",
      "  A --> C",
      "  classDef retained fill:#fff,stroke:#111;",
      "  class C retained;",
    ].join("\n");
    const parsed = mermaidFlowchartFamily.parseSource(source, "flowchart");
    const state = mermaidFlowchartFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const stableSource = applyFlowchartGfxVisualToSource(
      source,
      state.visualModel,
    );
    const stableModel = mermaidFlowchartFamily.parseSource(
      stableSource,
      "flowchart",
    ).model!;
    expect(createFlowchartGfxSubgraph(stableModel, [])).toBeNull();

    expect(
      createFlowchartGfxSubgraph(stableModel, ["B", "A", "missing"]),
    ).toBeNull();
    const created = createFlowchartGfxSubgraph(stableModel, ["B", "A", "B"]);
    expect(created?.nodeIds).toEqual(["B", "A"]);
    expect(created).toBeTruthy();
    if (!created) return;
    const grouped = applyFlowchartCreatedSubgraphMembership(
      {
        ...stableModel,
        subgraphs: [...(stableModel.subgraphs ?? []), created],
      },
      created.id,
      created.nodeIds,
    );
    const groupedSource = applyFlowchartGfxVisualToSource(
      stableSource,
      grouped,
    );
    expect(groupedSource).toContain("  %% unrelated annotation");
    expect(groupedSource).toContain("C[Outside]");
    expect(groupedSource).toContain(
      "  classDef retained fill:#fff,stroke:#111;",
    );
    expect(groupedSource).toContain("  class C retained;");

    const reparsedGrouped = mermaidFlowchartFamily.parseSource(
      groupedSource,
      "flowchart",
    ).model!;
    const group = reparsedGrouped.subgraphs?.find(
      ({ id }) => id === created.id,
    );
    expect(group?.nodeIds).toEqual(["A", "B"]);
    expect(group).toBeTruthy();
    if (!group) return;

    const nested = createFlowchartGfxSubgraph(reparsedGrouped, ["A", "B"]);
    expect(nested).toMatchObject({
      parentId: group.id,
      nodeIds: ["A", "B"],
    });
    if (!nested) return;
    let nestedModel: MermaidVisualModel =
      applyFlowchartCreatedSubgraphMembership(
        {
          ...reparsedGrouped,
          subgraphs: [...(reparsedGrouped.subgraphs ?? []), nested],
        },
        nested.id,
        nested.nodeIds,
      );
    const outside = nestedModel.nodes.find(({ id }) => id === "C")!;
    outside.x = nested.x + 20;
    outside.y = nested.y + 80;
    syncFlowchartGfxSubgraphMembership(nestedModel);
    expect(
      nestedModel.subgraphs?.some(({ nodeIds }) => nodeIds.includes("C")),
    ).toBe(false);

    nestedModel = reparentFlowchartGfxSubgraph(nestedModel, nested.id, "");
    nestedModel = reorderFlowchartGfxSubgraph(nestedModel, nested.id, -1);
    const nestedSource = applyFlowchartGfxVisualToSource(
      groupedSource,
      nestedModel,
    );
    const reparsedNested = mermaidFlowchartFamily.parseSource(
      nestedSource,
      "flowchart",
    ).model!;
    const reparsedNestedGroup = reparsedNested.subgraphs?.find(
      ({ id }) => id === nested.id,
    );
    expect(reparsedNestedGroup?.parentId).toBeUndefined();
    expect([...(reparsedNestedGroup?.nodeIds ?? [])].sort()).toEqual([
      "A",
      "B",
    ]);
    expect(nestedSource).toContain("%% unrelated annotation");
    expect(nestedSource).toContain("classDef retained fill:#fff,stroke:#111;");

    const unwrapped = deleteFlowchartGfxSelection(reparsedNested, {
      subgraphId: nested.id,
    });
    const unwrappedSource = applyFlowchartGfxVisualToSource(
      nestedSource,
      unwrapped,
    );
    expect(unwrappedSource).toContain("A[Alpha]");
    expect(unwrappedSource).toContain("B[Beta]");
    expect(unwrappedSource).toContain("C[Outside]");
    expect(unwrappedSource).toContain("%% unrelated annotation");
  });

  test("exposes frame read-through hooks without materializing a second editor implementation", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      "flowchart-elk LR\n  A --> B\n",
      "flowchart-elk",
    );
    const state = mermaidFlowchartFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const materialized: unknown[] = [];
    mermaidFlowchartFamily.materializeFrame(state.visualModel, {
      materializeVisualModel: (visualModel) => materialized.push(visualModel),
    });
    expect(materialized).toEqual([state.visualModel]);
  });

  test("keeps horizontal Flowchart ELK fan-out layers compact on the cross axis", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      [
        "flowchart-elk LR",
        "  A[Entry point] --> B[Detailed review checkpoint]",
        "  A --> C[Customer confirmation checkpoint]",
        "  A --> D[Operational readiness checkpoint]",
        "  A --> E[Compliance evidence checkpoint]",
        "  A --> F[Release decision checkpoint]",
        "  A --> G[Post release verification]",
      ].join("\n"),
      "flowchart-elk",
    );
    const state = mermaidFlowchartFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    const targets = state.visualModel.nodes.filter(({ id }) => id !== "A");
    const top = Math.min(...targets.map(({ y }) => y));
    const bottom = Math.max(...targets.map(({ height, y }) => y + height));

    expect(targets).toHaveLength(6);
    expect(bottom - top).toBeLessThanOrEqual(560);
  });

  test("returns an explicit source-only state for unsupported Flowchart syntax", () => {
    const parsed = mermaidFlowchartFamily.parseSource(
      "sequenceDiagram\n  Alice->>Bob: Hi\n",
      "sequenceDiagram",
    );
    const state = mermaidFlowchartFamily.toVisualModel(parsed);

    expect(parsed.model).toBeNull();
    expect(parsed.diagnostics[0]?.code).toBe(
      "flowchart.unsupported-diagram-type",
    );
    expect(state.kind).toBe("source-only");
  });
});
