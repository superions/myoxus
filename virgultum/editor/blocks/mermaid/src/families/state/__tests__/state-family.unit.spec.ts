import { describe, expect, test } from "vitest";

import {
  generateMermaidSourceFromGfxVisualModel,
  parseMermaidSourceToGfxVisualModel,
} from "../../../mermaid-gfx-graph-adapters.js";
import { mermaidStateFamily } from "../family.js";
import { stateProjectionBinding } from "../gfx-data.js";
import { mermaidVisualFamilyPayload } from "../../runtime/gfx-family-data.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import {
  resolveMermaidStateSource,
  deleteStateDescription,
  setStateHeading,
  deleteStateComposite,
  stateInsertAnchor,
  reparentStateObject,
} from "../../../engine/state/index.js";
import { validateMermaidSource } from "../../../renderer.js";
function named(model: MermaidVisualModel, id: string) {
  const node = [...model.nodes, ...(model.subgraphs ?? [])].find(
    (n) => stateProjectionBinding(n)?.sourceId === id,
  );
  expect(node, id).toBeDefined();
  return node!;
}

describe("Mermaid State family module", () => {
  test("keeps native State existence and scope when deleting its only alias or description", async () => {
    for (const declaration of [
      'state "Only heading" as A',
      "A: Only heading",
    ]) {
      const source = `stateDiagram-v2\nstate Flow {\n ${declaration}\n}\n`;
      const model = resolveMermaidStateSource(source).model!;
      const node = model.states[0]!;
      const result = deleteStateDescription(model, node.descriptions![0]!.id);
      expect(result.source).toBe("stateDiagram-v2\nstate Flow {\n A\n}\n");
      expect(result.model.states[0]).toMatchObject({
        sourceKey: node.sourceKey,
        parentId: "Flow",
        label: "A",
      });
      await validateMermaidSource(result.source);
      const { default: native } = await import("mermaid");
      const data = (
        (await native.mermaidAPI.getDiagramFromText(result.source))
          .db as unknown as {
          getData(): { nodes: Array<{ id: string; parentId?: string }> };
        }
      ).getData();
      expect(data.nodes.find((n) => n.id === "A")?.parentId).toBe("Flow");
    }
  });
  test("reparents the selected State with explicit relation scope impact while keeping its implicit neighbour", async () => {
    const source =
      "stateDiagram-v2\nstate Target {\n T\n}\nstate Flow {\n A --> B: keep\n}\n";
    const model = resolveMermaidStateSource(source).model!;
    for (const anchor of [{}, { parentId: "Target" }]) {
      const result = reparentStateObject(model, "A", anchor);
      expect(result.status).toBe("changed");
      expect(result.model.states.find((n) => n.id === "A")?.parentId).toBe(
        anchor.parentId,
      );
      expect(result.model.states.find((n) => n.id === "B")).toMatchObject({
        sourceKey: model.states.find((n) => n.id === "B")!.sourceKey,
        parentId: "Flow",
      });
      expect(result.model.transitions[0]).toMatchObject({
        id: model.transitions[0]!.id,
        label: "keep",
        parentId: undefined,
      });
      expect(
        result.impact.records.some((r) => r.id === model.transitions[0]!.id),
      ).toBe(true);
      await validateMermaidSource(result.source);
      const { default: native } = await import("mermaid");
      const data = (
        (await native.mermaidAPI.getDiagramFromText(result.source))
          .db as unknown as {
          getData(): { nodes: Array<{ id: string; parentId?: string }> };
        }
      ).getData();
      expect(data.nodes.find((n) => n.id === "A")?.parentId).toBe(
        anchor.parentId,
      );
      expect(data.nodes.find((n) => n.id === "B")?.parentId).toBe("Flow");
    }
  });

  test("retains repeated Composite bodies while editing, inserting and deleting their actual ranges", async () => {
    const source =
      'stateDiagram-v2\nstate "Pipeline" as A {\n direction LR\n [*] --> B\n}\n%% second body\nstate A {\n direction TB\n [*] --> C\n}\n';
    await validateMermaidSource(source);
    const result = resolveMermaidStateSource(source);
    expect(result.diagnostics).toEqual([]);
    const model = result.model!;
    expect(model.composites).toHaveLength(1);
    expect(model.composites[0]).toMatchObject({
      label: "Pipeline",
      direction: "LR",
    });
    const starts = model.states.filter((n) => n.kind === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]!.relationKeys).toHaveLength(2);
    const c = model.states.find((n) => n.id === "C")!;
    const anchor = stateInsertAnchor(model, {
      parentId: "A",
      regionKey: c.regionKey!,
    });
    expect(anchor?.offset).toBe(source.lastIndexOf("}"));
    const visual = parseMermaidSourceToGfxVisualModel(source).model!;
    expect(
      visual.nodes.find((n) => stateProjectionBinding(n)?.sourceId === "C"),
    ).toBeDefined();
    const edited = setStateHeading(model, "A", "Updated pipeline");
    expect(edited.status).toBe("changed");
    expect(edited.source).toBe(
      source.replace('"Pipeline"', '"Updated pipeline"'),
    );
    const reassigned = deleteStateComposite(model, "A", {
      children: "reassign",
    });
    expect(reassigned.status).toBe("changed");
    expect(
      reassigned.model.states.find((n) => n.id === "B")?.parentId,
    ).toBeUndefined();
    expect(
      reassigned.model.states.find((n) => n.id === "C")?.parentId,
    ).toBeUndefined();
    expect(reassigned.source).toContain("%% second body");
    expect(reassigned.model.composites).toEqual([]);
  });

  test("wraps State parsing and source generation with start/end transitions", () => {
    const parsed = mermaidStateFamily.parseSource(
      'stateDiagram-v2\n  state "Waiting for Review" as Waiting\n  [*] --> Waiting\n  Waiting --> [*] : done\n',
      "stateDiagram-v2",
    );
    const state = mermaidStateFamily.toVisualModel(parsed);

    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    expect(state.visualModel.diagramType).toBe("stateDiagram-v2");
    if (state.visualModel.diagramType !== "stateDiagram-v2") return;
    expect(state.visualModel.states.map(({ id, kind }) => [id, kind])).toEqual([
      ["Waiting", "state"],
      ["root::__start__", "start"],
      ["root::__end__", "end"],
    ]);
    expect(state.visualModel.transitions[1]).toMatchObject({
      from: "Waiting",
      label: "done",
      to: "root::__end__",
    });
    const gfx = parseMermaidSourceToGfxVisualModel(parsed.source);
    expect(gfx.model?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: named(gfx.model!, "root::__start__").id,
          sourcePosition: [expect.any(Number), expect.any(Number)],
          target: named(gfx.model!, "Waiting").id,
          targetPosition: [expect.any(Number), expect.any(Number)],
        }),
        expect.objectContaining({
          source: named(gfx.model!, "Waiting").id,
          sourcePosition: [expect.any(Number), expect.any(Number)],
          target: named(gfx.model!, "root::__end__").id,
          targetPosition: [expect.any(Number), expect.any(Number)],
        }),
      ]),
    );
    expect(
      gfx.model?.nodes
        .filter((node) =>
          ["start", "end"].includes(stateProjectionBinding(node)?.kind ?? ""),
        )
        .every((node) => node.displayLabel === ""),
    ).toBe(true);
    expect(
      mermaidStateFamily.applyVisualToSource(state.visualModel, parsed.source)
        .source,
    ).toContain("Waiting --> [*] : done");
  });

  test("models State notes as editable family notation without losing scope", () => {
    const source = [
      "stateDiagram-v2",
      '  state "Review flow" as Review {',
      '    state "Needs QA" as QA',
      "    note right of QA",
      "      Requires two approvals",
      "    end note",
      "    QA --> [*] : approve",
      "  }",
    ].join("\n");
    const parsed = mermaidStateFamily.parseSource(source, "stateDiagram-v2");
    const state = mermaidStateFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "stateDiagram-v2") return;
    expect(state.visualModel.notes).toEqual([
      expect.objectContaining({
        label: "Requires two approvals",
        parentId: "Review",
        placement: "right of",
        stateId: "QA",
      }),
    ]);

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    const note = gfx.model?.nodes.find(
      (node) => stateProjectionBinding(node)?.role === "note",
    );
    expect(note?.label).toBe("Requires two approvals");
    expect(mermaidVisualFamilyPayload(note!.familyData, "state")).toMatchObject(
      {
        notePlacement: "right of",
        noteStateId: "QA",
      },
    );
    if (!gfx.model || !note) return;
    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      nodes: gfx.model.nodes.map((node) =>
        node.id === note.id
          ? { ...node, label: "Security and product approve" }
          : node,
      ),
    });
    expect(editedSource).toContain("    note right of QA");
    expect(editedSource).toContain("      Security and product approve");
    expect(editedSource).toContain("    end note");
    expect(editedSource).toContain("    QA --> [*] : approve");
  });

  test("models simple composite State containers as family-owned subgraphs", () => {
    const source = [
      "stateDiagram-v2",
      '  state "Review flow" as Review {',
      "    [*] --> Draft",
      '    state "Needs QA" as QA',
      "    Draft --> QA : submit",
      "    QA --> [*] : approve",
      "  }",
      "  Review --> Done : close",
    ].join("\n");
    const parsed = mermaidStateFamily.parseSource(source, "stateDiagram-v2");
    const state = mermaidStateFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "stateDiagram-v2") return;

    const scope = state.visualModel.composites[0]!.primaryRegionKey!;
    expect(state.visualModel.composites).toEqual([
      expect.objectContaining({
        id: "Review",
        label: "Review flow",
        nodeIds: expect.arrayContaining([
          `${scope}::__start__`,
          "Draft",
          "QA",
          `${scope}::__end__`,
        ]),
      }),
    ]);

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    expect(gfx.model?.subgraphs).toEqual([
      expect.objectContaining({
        id: state.visualModel.composites[0]!.sourceKey,
        nodeIds: state.visualModel.states
          .filter((n) => n.parentId === "Review")
          .map((n) => n.sourceKey),
        title: "Review flow",
      }),
    ]);
    if (!gfx.model) return;
    const review = gfx.model.subgraphs?.[0];
    const draft = gfx.model.nodes.find(
      (node) => stateProjectionBinding(node)?.sourceId === "Draft",
    );
    const qa = gfx.model.nodes.find(
      (node) => stateProjectionBinding(node)?.sourceId === "QA",
    );
    const end = gfx.model.nodes.find(
      (node) => stateProjectionBinding(node)?.sourceId === `${scope}::__end__`,
    );
    expect(draft).toBeTruthy();
    expect(qa).toBeTruthy();
    expect(end).toBeTruthy();
    if (!review || !draft || !qa || !end) return;
    expect(draft.y - review.y).toBeGreaterThanOrEqual(
      stateProjectionBinding(review!)!.headerHeight,
    );
    expect(qa.y).toBeGreaterThan(draft.y + draft.height);
    expect(end.y).toBeGreaterThan(qa.y + qa.height);
    expect(review.height).toBeGreaterThan(end.y + end.height - review.y);
    expect(
      gfx.model.edges.find(
        (edge) => edge.source === draft!.id && edge.target === qa!.id,
      ),
    ).toMatchObject({ label: "submit" });

    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      nodes: gfx.model.nodes.map((node) =>
        stateProjectionBinding(node)?.sourceId === "QA"
          ? { ...node, label: "Quality check" }
          : node,
      ),
      subgraphs: gfx.model.subgraphs?.map((subgraph) =>
        stateProjectionBinding(subgraph)?.sourceId === "Review"
          ? { ...subgraph, title: "Review lane" }
          : subgraph,
      ),
    });

    expect(editedSource).toContain('state "Review lane" as Review {');
    expect(editedSource).toContain("    [*] --> Draft");
    expect(editedSource).toContain('    state "Quality check" as QA');
    expect(editedSource).toContain("    Draft --> QA : submit");
    expect(editedSource).toContain("    QA --> [*] : approve");
    expect(editedSource).toContain("  Review --> Done : close");
  });

  test("models nested State composite containers without flattening hierarchy", () => {
    const source = [
      "stateDiagram-v2",
      '  state "Parent flow" as Parent {',
      "    [*] --> Draft",
      '    state "QA lane" as QAFlow {',
      "      [*] --> Review",
      '      state "Manual Review" as Review',
      "      Review --> [*] : approve",
      "    }",
      "    Draft --> QAFlow : submit",
      "    QAFlow --> [*] : done",
      "  }",
      "  Parent --> Done : close",
    ].join("\n");
    const parsed = mermaidStateFamily.parseSource(source, "stateDiagram-v2");
    const state = mermaidStateFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "stateDiagram-v2") return;

    const parentScope = state.visualModel.composites.find(
        (c) => c.id === "Parent",
      )!.primaryRegionKey!,
      childScope = state.visualModel.composites.find(
        (c) => c.id === "QAFlow",
      )!.primaryRegionKey!;
    expect(state.visualModel.composites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "Parent",
          label: "Parent flow",
          parentId: undefined,
        }),
        expect.objectContaining({
          id: "QAFlow",
          label: "QA lane",
          parentId: "Parent",
        }),
      ]),
    );
    expect(
      state.visualModel.transitions.map(({ from, parentId, to }) => [
        parentId,
        from,
        to,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["Parent", `${parentScope}::__start__`, "Draft"],
        ["QAFlow", `${childScope}::__start__`, "Review"],
        ["QAFlow", "Review", `${childScope}::__end__`],
        ["Parent", "Draft", "QAFlow"],
        ["Parent", "QAFlow", `${parentScope}::__end__`],
        [undefined, "Parent", "Done"],
      ]),
    );

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    const parentSubgraph = gfx.model?.subgraphs?.find(
      (subgraph) => stateProjectionBinding(subgraph)?.sourceId === "Parent",
    );
    const qaSubgraph = gfx.model?.subgraphs?.find(
      (subgraph) => stateProjectionBinding(subgraph)?.sourceId === "QAFlow",
    );
    expect(parentSubgraph?.title).toBe("Parent flow");
    expect(stateProjectionBinding(parentSubgraph!)).toMatchObject({
      parentId: null,
    });
    expect(qaSubgraph?.title).toBe("QA lane");
    expect(stateProjectionBinding(qaSubgraph!)).toMatchObject({
      parentId: "Parent",
    });
    if (!gfx.model) return;
    const parent = gfx.model.subgraphs?.find(
      (subgraph) => stateProjectionBinding(subgraph)?.sourceId === "Parent",
    );
    const qaFlow = gfx.model.subgraphs?.find(
      (subgraph) => stateProjectionBinding(subgraph)?.sourceId === "QAFlow",
    );
    expect(parent).toBeTruthy();
    expect(qaFlow).toBeTruthy();
    if (!parent || !qaFlow) return;
    expect(qaFlow.y).toBeGreaterThan(parent.y);
    expect(qaFlow.y + qaFlow.height).toBeLessThan(parent.y + parent.height);
    expect(gfx.model.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: named(gfx.model!, "Draft").id,
          sourcePosition: [expect.any(Number), expect.any(Number)],
          target: named(gfx.model!, "QAFlow").id,
          targetPosition: [expect.any(Number), expect.any(Number)],
        }),
        expect.objectContaining({
          source: named(gfx.model!, "QAFlow").id,
          sourcePosition: [expect.any(Number), expect.any(Number)],
          target: named(gfx.model!, `${parentScope}::__end__`).id,
          targetPosition: [expect.any(Number), expect.any(Number)],
        }),
        expect.objectContaining({
          source: named(gfx.model!, "Parent").id,
          sourcePosition: [0.5, 1],
          target: named(gfx.model!, "Done").id,
          targetPosition: [0.5, 0],
        }),
      ]),
    );

    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      nodes: gfx.model.nodes.map((node) =>
        stateProjectionBinding(node)?.sourceId === "Review"
          ? { ...node, label: "Final QA" }
          : node,
      ),
      subgraphs: gfx.model.subgraphs?.map((subgraph) =>
        stateProjectionBinding(subgraph)?.sourceId === "QAFlow"
          ? { ...subgraph, title: "QA subflow" }
          : subgraph,
      ),
    });

    expect(editedSource).toContain('state "Parent flow" as Parent {');
    expect(editedSource).toContain('    state "QA subflow" as QAFlow {');
    expect(editedSource).toContain('      state "Final QA" as Review');
    expect(editedSource).toContain("      Review --> [*] : approve");
    expect(editedSource).toContain("    Draft --> QAFlow : submit");
    expect(editedSource).toContain("  Parent --> Done : close");
  });

  test("models State regions as source-preserving composite dividers", () => {
    const source = [
      "stateDiagram-v2",
      '  state "Active flow" as Active {',
      "    [*] --> CPU",
      '    state "CPU Running" as CPU',
      "    CPU --> [*] : idle",
      "    --",
      "    [*] --> Memory",
      '    state "Memory Access" as Memory',
      "    Memory --> [*] : done",
      "    note left of Memory",
      "      Preserved in the memory region",
      "    end note",
      "  }",
    ].join("\n");
    const parsed = mermaidStateFamily.parseSource(source, "stateDiagram-v2");
    const state = mermaidStateFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    if (state.visualModel.diagramType !== "stateDiagram-v2") return;

    expect(state.visualModel.regions).toEqual([
      expect.objectContaining({
        compositeId: "Active",
        regionIndex: 1,
      }),
    ]);
    const primary = state.visualModel.composites[0]!.primaryRegionKey!,
      secondary = state.visualModel.regions[0]!.id;
    expect(
      state.visualModel.states.map(({ id, regionIndex }) => [id, regionIndex]),
    ).toEqual(
      expect.arrayContaining([
        [`${primary}::__start__`, 0],
        ["CPU", 0],
        [`${secondary}::__start__`, 1],
        ["Memory", 1],
      ]),
    );

    const gfx = parseMermaidSourceToGfxVisualModel(source);
    expect(
      gfx.model?.nodes
        .filter((n) => stateProjectionBinding(n)?.role === "region")
        .map((n) => n.id),
    ).toEqual([secondary]);
    expect(gfx.model).not.toBeNull();
    if (!gfx.model) throw new Error("Missing State projection");
    const activeComposite = named(gfx.model!, "Active"),
      regionBand = named(gfx.model!, secondary);
    expect(regionBand.x).toBeGreaterThan(activeComposite.x);
    expect(regionBand.x + regionBand.width).toBeLessThan(
      activeComposite.x + activeComposite.width,
    );
    const editedSource = generateMermaidSourceFromGfxVisualModel(source, {
      ...gfx.model,
      nodes: gfx.model.nodes.map((node) =>
        stateProjectionBinding(node)?.sourceId === "Memory"
          ? { ...node, label: "Memory bus" }
          : node,
      ),
    });

    expect(editedSource).toContain("    --");
    expect(editedSource).toContain('    state "Memory bus" as Memory');
    expect(editedSource.indexOf("CPU --> [*] : idle")).toBeLessThan(
      editedSource.indexOf("    --"),
    );
    expect(editedSource.indexOf("    --")).toBeLessThan(
      editedSource.indexOf('state "Memory bus" as Memory'),
    );
    expect(editedSource.indexOf("    --")).toBeLessThan(
      editedSource.indexOf("    note left of Memory"),
    );
    expect(editedSource.indexOf("    Memory --> [*] : done")).toBeLessThan(
      editedSource.indexOf("    note left of Memory"),
    );
  });

  test("returns source-only state for unsupported family syntax", () => {
    const parsed = mermaidStateFamily.parseSource(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
      "erDiagram",
    );
    const state = mermaidStateFamily.toVisualModel(parsed);

    expect(parsed.model).toBeNull();
    expect(parsed.diagnostics[0]?.code).toBe("missing-header");
    expect(state.kind).toBe("source-only");
  });
});
