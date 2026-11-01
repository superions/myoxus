import { describe, expect, test } from "vitest";

import {
  generateMermaidSourceFromGfxVisualModel,
  parseMermaidSourceToGfxVisualModel,
} from "../../../mermaid-gfx-graph-adapters.js";
import { mermaidMindmapFamily } from "../../mindmap/family.js";
import { readMindmapProjectionModel } from "../../mindmap/source-application.js";
import { moveMindmapSubtree } from "../../../engine/mindmap/index.js";
import { mermaidRequirementFamily } from "../family.js";
import { mermaidBlockFamily } from "../../block/family.js";
import { readBlockProjectionModel } from "../../block/source-application.js";
import { updateBlockColumns } from "../../../engine/block/index.js";
import {
  deleteRequirementSelection,
  parseMermaidRequirementSource,
  requirementDeleteImpact,
} from "../../../engine/requirement/index.js";

describe("Mermaid Requirement family module", () => {
  test("preserves Block and Mindmap hierarchy semantics through their registered owners", () => {
    const block = mermaidBlockFamily.parseSource(
      'block-beta\n  columns 2\n  A["Input"]\n  B["Output"]\n  A -- "flow" --> B\n',
      "block",
    );
    const blockState = mermaidBlockFamily.toVisualModel(block);
    expect(blockState.kind).toBe("editable");
    if (blockState.kind !== "editable") return;
    expect(blockState.visualModel.diagramType).toBe("block");
    if (blockState.visualModel.diagramType !== "block") return;
    expect(blockState.visualModel.columns).toBe(2);
    expect(blockState.visualModel.edges[0]?.label).toBe("flow");
    const blockGfx = parseMermaidSourceToGfxVisualModel(block.source);
    expect(
      blockGfx.model &&
        readBlockProjectionModel(block.source, blockGfx.model)?.columns,
    ).toBe(2);
    expect(blockGfx.model?.edges[0]).toMatchObject({
      connectorMode: "orthogonal",
      labelPlacement: "center",
      sourcePosition: [0.5, 1],
      targetPosition: [0.5, 1],
    });
    expect(
      updateBlockColumns(blockState.visualModel, null, 4).source,
    ).toContain("columns 4");

    const mindmap = mermaidMindmapFamily.parseSource(
      "mindmap\n  root((Myoxus))\n    Documents\n    Diagrams\n",
      "mindmap",
    );
    const mindmapState = mermaidMindmapFamily.toVisualModel(mindmap);
    expect(mindmapState.kind).toBe("editable");
    if (mindmapState.kind !== "editable") return;
    expect(mindmapState.visualModel.diagramType).toBe("mindmap");
    if (mindmapState.visualModel.diagramType !== "mindmap") return;
    expect(mindmapState.visualModel.nodes[0]).toMatchObject({
      label: "Myoxus",
      root: true,
      shape: "circle",
    });
    expect(mindmapState.visualModel.nodes[1]?.parentId).toBe("node-1");
    const mindmapGfx = parseMermaidSourceToGfxVisualModel(mindmap.source);
    expect(mindmapGfx.model?.edges[0]).toMatchObject({
      connectorMode: "curve",
      sourcePosition: [1, 0.5],
      targetPosition: [0, 0.5],
    });
  });

  test("keeps free connector edits inert and reparents through the checked Mindmap owner", () => {
    const source = [
      "mindmap",
      "  root((Myoxus))",
      "    Documents",
      "    Export",
    ].join("\n");
    const parsed = parseMermaidSourceToGfxVisualModel(source);
    const model = parsed.model!;
    const tree = readMindmapProjectionModel(source, model)!;
    const exported = model.nodes.find((node) => node.label === "Export")!;
    const documents = model.nodes.find((node) => node.label === "Documents")!;
    const reparented = {
      ...model,
      edges: model.edges.map((edge) =>
        edge.target === exported.id ? { ...edge, source: documents.id } : edge,
      ),
    };
    expect(generateMermaidSourceFromGfxVisualModel(source, reparented)).toBe(
      source,
    );
    const nextSource = moveMindmapSubtree(
      tree,
      exported.id,
      documents.id,
    ).source;

    expect(nextSource).toContain("root((Myoxus))");
    expect(nextSource).toContain("  Documents");
    expect(nextSource).toContain("    Export");
  });

  test("owns Requirement cards, typed relations and lossless property writes", () => {
    const source =
      'requirementDiagram\n  functionalRequirement req1 {\n    id: "R-1"\n    text: Export works\n    risk: high\n    verifymethod: test\n  }\n  element doc1 {\n    type: artifact\n    docref: docs/export.md\n  }\n  req1 - verifies -> doc1\n';
    const parsed = mermaidRequirementFamily.parseSource(
      source,
      "requirementDiagram",
    );
    const state = mermaidRequirementFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;
    expect(state.visualModel.diagramType).toBe("requirementDiagram");
    if (state.visualModel.diagramType !== "requirementDiagram") return;
    expect(state.visualModel.requirements[0]).toMatchObject({
      requirementId: "R-1",
      requirementType: "functionalRequirement",
      risk: "high",
      verifyMethod: "test",
    });
    const gfx = parseMermaidSourceToGfxVisualModel(source).model!;
    expect(gfx.edges[0]).toMatchObject({
      connectorMode: "orthogonal",
    });
    expect(gfx.edges[0].familyData).toMatchObject({
      family: "requirement",
      payload: { relationKind: "verifies" },
    });
    expect(
      gfx.nodes[0]?.details
        ?.filter((detail) => detail.kind !== "separator")
        .map(({ sourceKey }) => sourceKey),
    ).toEqual([
      state.visualModel.requirements[0].sourceKey,
      state.visualModel.requirements[0].propertyKeys?.id?.[0],
      state.visualModel.requirements[0].propertyKeys?.risk?.[0],
      state.visualModel.requirements[0].propertyKeys?.verifymethod?.[0],
      state.visualModel.requirements[0].propertyKeys?.text?.[0],
    ]);
    expect(generateMermaidSourceFromGfxVisualModel(source, gfx)).toContain(
      "req1 - verifies -> doc1",
    );
  });

  test("deletes a Requirement alias group without deleting its Element namesake or retained references", () => {
    const group =
      'requirement Shared {\n text: "effective"\n}\nfunctionalRequirement Shared {\n text: "ignored"\n}\n';
    const retained =
      'element Shared {\n type: "fallback"\n}\nelement Peer {\n}\nShared - traces -> Peer\nclassDef emphasis fill:#fff\nclass Shared,Peer emphasis\n';
    const model = parseMermaidRequirementSource(
      `requirementDiagram\n${group}${retained}`,
    )!;
    const keys = [model.requirements[0].sourceKey!];
    expect(requirementDeleteImpact(model, keys).changesResolution).toBe(true);
    const result = deleteRequirementSelection(model, keys, {
      confirmed: true,
      references: "keep",
    });
    expect(result.source).toBe(`requirementDiagram\n${retained}`);
    expect(result.model.requirements).toEqual([]);
    expect(result.model.relations[0].fromId).toBe(result.model.elements[0].id);
    expect(result.model.relations[0].sourceKey).toBe(
      model.relations[0].sourceKey,
    );
  });

  test("publishes only the diagram types owned by the Requirement family", () => {
    expect(mermaidRequirementFamily.id).toBe("requirement");
    expect(mermaidRequirementFamily.diagramTypes).toEqual([
      "requirementDiagram",
    ]);
  });

  test("returns source-only state for unsupported family syntax", () => {
    const parsed = mermaidRequirementFamily.parseSource(
      "treemap\n  Root\n    Child: 10\n",
      "treemap",
    );
    const state = mermaidRequirementFamily.toVisualModel(parsed);

    expect(parsed.model).toBeNull();
    expect(parsed.diagnostics[0]?.code).toBe(
      "requirement.unsupported-diagram-type",
    );
    expect(state.kind).toBe("source-only");
  });
});
