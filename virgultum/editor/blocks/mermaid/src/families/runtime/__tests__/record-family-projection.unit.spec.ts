import { Bound } from "@virgultum/global/gfx";
import { describe, expect, test } from "vitest";

import {
  getMermaidVisualNodeDetailElementEntries,
  toMermaidNodeDetailElementProps,
  toMermaidShapeElementProps,
} from "../../runtime/gfx-element-projection.js";
import { createMermaidVisualModelFromGfxElements } from "../../runtime/gfx-element-readback.js";
import { projectNeutralMermaidGfxNodeElement } from "../../runtime/gfx-element-projection-defaults.js";
import { MERMAID_GFX_DETAIL_ROLE } from "../../runtime/gfx-element-roles.js";
import { typeOwnedMermaidNodeDetailElementProjection } from "../../runtime/gfx-owner-hooks.js";
import {
  generateMermaidSourceFromGfxVisualModel,
  parseMermaidSourceToGfxVisualModel,
} from "../../../mermaid-gfx-graph-adapters.js";
import { mermaidClassFamily } from "../../class/family.js";
import { mermaidErFamily } from "../../er/family.js";
import { classEdgeGfxData } from "../../class/gfx-data.js";
import { erEdgeGfxData, erProjectionBinding } from "../../er/gfx-data.js";
import { projectRequirementMaterializedNode } from "../../requirement/object-projection.js";
import {
  requirementEdgeGfxData,
  requirementNodeGfxData,
} from "../../requirement/gfx-data.js";

describe("Record family GFX projection", () => {
  test("wraps Class Diagram parsing and source generation without losing member zones", () => {
    const parsed = mermaidClassFamily.parseSource(
      "classDiagram\n  class Document {\n    +title\n    +diagramSource\n  }\n  Document --> MermaidDiagram : renders\n",
      "classDiagram",
    );
    const state = mermaidClassFamily.toVisualModel(parsed);

    expect(parsed.diagnostics).toEqual([]);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") return;

    expect(state.visualModel.diagramType).toBe("classDiagram");
    if (state.visualModel.diagramType !== "classDiagram") return;
    expect(state.visualModel.nodes[0]).toMatchObject({
      sourceId: "Document",
    });
    expect(state.visualModel.nodes[0]?.members.map((m) => m.raw)).toEqual([
      "+title",
      "+diagramSource",
    ]);
    expect(state.visualModel.relations[0]).toMatchObject({
      fromSourceId: "Document",
      kind: "-->",
      label: "renders",
      toSourceId: "MermaidDiagram",
    });
    expect(
      mermaidClassFamily.applyVisualToSource(
        state.visualModel,
        "classDiagram\n  class Document {\n    +title\n    +exportPdf()\n  }\n",
      ).source,
    ).toContain("class Document {");
  });

  test("retains ER attributes, independent cardinalities and their record identities", () => {
    const source =
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string id PK\n    string name\n  }\n";
    const parsed = mermaidErFamily.parseSource(source, "erDiagram");
    const state = mermaidErFamily.toVisualModel(parsed);
    expect(state.kind).toBe("editable");
    if (state.kind !== "editable") throw new Error("ER Source rejected");
    const customer = state.visualModel.entities.find(
      (n) => n.id === "CUSTOMER",
    )!;
    expect(customer.attributes).toMatchObject([
      { keys: ["PK"], name: "id", type: "string" },
      { keys: [], name: "name", type: "string" },
    ]);
    expect(new Set(customer.attributes.map((a) => a.id)).size).toBe(2);
    expect(
      customer.attributes.every((a) =>
        state.visualModel.sourceDocument.records.some(
          (r) => r.sourceKey === a.id && r.kind === "attribute",
        ),
      ),
    ).toBe(true);
    expect(state.visualModel.relationships[0]).toMatchObject({
      from: "CUSTOMER",
      cardinalityA: "exactly-one",
      label: "places",
      to: "ORDER",
      cardinalityB: "zero-or-many",
      identification: "--",
    });
    expect(
      mermaidErFamily.applyVisualToSource(state.visualModel, source).source,
    ).toBe(source);
  });

  test("projects Relationship node details as structured GFX metadata", () => {
    const erParsed = parseMermaidSourceToGfxVisualModel(
      "erDiagram\n  CUSTOMER {\n    string id PK\n    string name\n  }\n",
    );
    const node = erParsed.model!.nodes[0]!;
    expect(erProjectionBinding(node)).toMatchObject({
      sourceId: "CUSTOMER",
      sourceKey: node.id,
    });
    expect(node).toMatchObject({
      displayLabel: "CUSTOMER",
      shape: "rect",
      textAlign: "left",
      textVerticalAlign: "top",
    });
    const fields = node.details!.filter(
      (d) => d.kind === "field" && d.id === d.sourceKey,
    );
    expect(fields.map((d) => d.label)).toEqual(["id", "name"]);
    expect(
      fields.every((d) =>
        node.details!.some((c) => c.sourceKey === d.id && c.label === "string"),
      ),
    ).toBe(true);
    expect(node.details!.find((d) => d.label === "PK")?.sourceKey).toBe(
      fields[0].sourceKey,
    );

    const requirementParsed = parseMermaidSourceToGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Export works\n    risk: medium\n    verifymethod: test\n  }\n  element doc1 {\n    type: document\n    docref: docs/export.md\n  }\n",
    );
    expect(requirementParsed.model?.nodes[0]).toMatchObject({
      details: expect.arrayContaining([
        {
          id: "requirement-property-req1-id",
          kind: "requirement-property",
          label: "id",
          order: 1,
          sourceKey: requirementNodeGfxData(requirementParsed.model!.nodes[0])
            ?.propertyKeys?.id?.[0],
          value: "1",
        },
        {
          id: "requirement-property-req1-text",
          kind: "requirement-property",
          label: "text",
          order: 4,
          sourceKey: requirementNodeGfxData(requirementParsed.model!.nodes[0])
            ?.propertyKeys?.text?.[0],
          value: "Export works",
        },
      ]),
      textAlign: "left",
      textVerticalAlign: "top",
    });
    expect(
      requirementNodeGfxData(requirementParsed.model!.nodes[0]),
    ).toMatchObject({
      requirementId: "1",
      requirementType: "requirement",
      risk: "medium",
      text: "Export works",
      verifyMethod: "test",
    });
    expect(requirementParsed.model?.nodes[1]).toMatchObject({
      details: expect.arrayContaining([
        {
          id: "requirement-property-doc1-type",
          kind: "requirement-property",
          label: "type",
          order: 1,
          sourceKey: requirementNodeGfxData(requirementParsed.model!.nodes[1])
            ?.propertyKeys?.type?.[0],
          value: "document",
        },
        {
          id: "requirement-property-doc1-docref",
          kind: "requirement-property",
          label: "docref",
          order: 2,
          sourceKey: requirementNodeGfxData(requirementParsed.model!.nodes[1])
            ?.propertyKeys?.docref?.[0],
          value: "docs/export.md",
        },
      ]),
      textAlign: "left",
      textVerticalAlign: "top",
    });
    expect(
      requirementNodeGfxData(requirementParsed.model!.nodes[1]),
    ).toMatchObject({
      docRef: "docs/export.md",
      elementType: "document",
      kind: "element",
    });
  });

  test("sizes Relationship detail rows from visible content instead of semantic order gaps", () => {
    const erParsed = parseMermaidSourceToGfxVisualModel(
      "erDiagram\n  CUSTOMER {\n    string id PK\n    uuid workspace_id FK\n  }\n",
    );
    expect(erParsed.model?.nodes[0]).toMatchObject({
      displayLabel: "CUSTOMER",
    });
    expect(erParsed.model?.nodes[0]?.width).toBeGreaterThan(0);

    const requirementParsed = parseMermaidSourceToGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Export works reliably\n    risk: high\n  }\n",
    );
    const requirementNode = requirementParsed.model?.nodes[0];
    expect(requirementNode?.displayLabel).toBe("req1");
    expect(requirementNode?.height).toBeGreaterThanOrEqual(150);
    const entries = requirementNode
      ? getMermaidVisualNodeDetailElementEntries({ nodes: [requirementNode] })
      : [];
    const rowBounds = entries
      .filter(({ detail }) => detail.kind !== "separator")
      .map(
        ({ node, detail }) =>
          typeOwnedMermaidNodeDetailElementProjection(
            requirementParsed.model!,
            node,
            detail,
          )!.relativeBound!,
      );
    expect(
      rowBounds.map(
        (bound, index) =>
          index === 0 ||
          bound.y >= rowBounds[index - 1].y + rowBounds[index - 1].height,
      ),
    ).toEqual([true, true, true, true]);
  });

  test("keeps widened Relationship nodes from overlapping same-row neighbours", () => {
    const parsed = parseMermaidSourceToGfxVisualModel(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string id PK\n    uuid workspace_id FK\n  }\n  ORDER {\n    string id PK\n  }\n",
    );
    const customer = parsed.model?.nodes.find(
      (node) => erProjectionBinding(node)?.sourceId === "CUSTOMER",
    );
    const order = parsed.model?.nodes.find(
      (node) => erProjectionBinding(node)?.sourceId === "ORDER",
    );

    expect(customer).toBeDefined();
    expect(order).toBeDefined();
    if (!customer || !order) return;

    expect(
      customer.x + customer.width <= order.x ||
        order.x + order.width <= customer.x ||
        customer.y + customer.height <= order.y ||
        order.y + order.height <= customer.y,
    ).toBe(true);
  });

  test("keeps large ER detail-heavy models bounded and non-overlapping", () => {
    const entityCount = 36;
    const source = [
      "erDiagram",
      ...Array.from({ length: entityCount }, (_, index) => {
        const name = `ENTITY_${String(index + 1).padStart(2, "0")}`;
        const next =
          index < entityCount - 1
            ? `\n  ${name} ||--o{ ENTITY_${String(index + 2).padStart(2, "0")} : owns`
            : "";
        return [
          `  ${name} {`,
          "    string id PK",
          "    uuid workspace_id FK",
          "    string display_name",
          "  }",
          next.trimEnd(),
        ]
          .filter(Boolean)
          .join("\n");
      }),
    ].join("\n");

    const started = performance.now();
    const parsed = parseMermaidSourceToGfxVisualModel(source);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(parsed.model?.nodes).toHaveLength(entityCount);
    expect(parsed.model?.edges).toHaveLength(entityCount - 1);

    const nodes = parsed.model?.nodes ?? [];
    const detailEntries = parsed.model
      ? getMermaidVisualNodeDetailElementEntries(parsed.model)
      : [];
    expect(
      detailEntries.filter(
        ({ detail }) =>
          detail.kind === "field" && detail.id === detail.sourceKey,
      ),
    ).toHaveLength(entityCount * 3);
    for (const node of nodes) {
      const binding = erProjectionBinding(node)!;
      expect(node.width).toBeGreaterThanOrEqual(
        binding.columns.reduce((a, b) => a + b, 0),
      );
      expect(node.height).toBeGreaterThanOrEqual(
        binding.headerHeight + binding.rowHeight * 4,
      );
      expect(
        [node.x, node.y, node.width, node.height].every(Number.isFinite),
      ).toBe(true);
    }

    for (let i = 0; i < nodes.length; i++) {
      for (const b of nodes.slice(i + 1)) {
        const a = nodes[i];
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true);
      }
    }
  });

  test("keeps Requirement semantic fields authoritative over rendered detail edits", () => {
    const parsed = parseMermaidSourceToGfxVisualModel(
      "requirementDiagram\n  performanceRequirement req1 {\n    id: 1\n    text: Export works\n    risk: high\n  }\n  element doc1 {\n    type: document\n    docref: docs/export.md\n  }\n",
    );
    const model = parsed.model;
    expect(model).not.toBeNull();
    if (!model) return;

    const ownerBound = new Bound(0, 0, 900, 600);
    const shapeElements = model.nodes.map((node) => {
      const props = toMermaidShapeElementProps(
        node,
        ownerBound,
        undefined,
        undefined,
        projectNeutralMermaidGfxNodeElement(node),
      );
      return {
        id: `shape-${node.id}`,
        props,
        text: props.text,
        textAlign: props.textAlign,
        textVerticalAlign: props.textVerticalAlign,
        type: "shape" as const,
        xywh: new Bound(node.x, node.y, node.width, node.height).serialize(),
      };
    });
    const detailElements = getMermaidVisualNodeDetailElementEntries(model).map(
      ({ detail, elementId, node, rowIndex }) => {
        const props = toMermaidNodeDetailElementProps({
          detail,
          ownerBound,
          node,
          projection: typeOwnedMermaidNodeDetailElementProjection(
            model,
            node,
            detail,
          )!,
          rowIndex,
        });
        const text =
          detail.sourceKey === "type" && node.id === "req1"
            ? "type: functionalRequirement"
            : detail.sourceKey === "type" && node.id === "doc1"
              ? "type: artifact"
              : props.text;
        return {
          id: elementId,
          props,
          text,
          type: "shape" as const,
          xywh: props.xywh,
        };
      },
    );

    const roundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "requirementDiagram",
      direction: "LR",
      elements: [...shapeElements, ...detailElements],
      ownerBound,
      previousModel: model,
    });
    const ownedRoundtrip = roundtrip
      ? {
          ...roundtrip,
          nodes: roundtrip.nodes.map((node) =>
            projectRequirementMaterializedNode(node, "requirementDiagram"),
          ),
        }
      : null;
    const requirement = ownedRoundtrip?.nodes.find(
      (node) => node.id === "req1",
    );
    const element = ownedRoundtrip?.nodes.find((node) => node.id === "doc1");

    expect(requirementNodeGfxData(requirement!)).toMatchObject({
      kind: "requirement",
      requirementType: "performanceRequirement",
    });
    expect(requirementNodeGfxData(element!)).toMatchObject({
      elementType: "document",
      kind: "element",
    });
  });

  test("round-trips Relationship detail metadata through GFX shape props", () => {
    const parsed = parseMermaidSourceToGfxVisualModel(
      "classDiagram\n  class Document {\n    +title\n    +exportPdf()\n  }\n",
    );
    const model = parsed.model;
    expect(model).not.toBeNull();
    if (!model) return;

    const ownerBound = new Bound(0, 0, 800, 600);
    const node = model.nodes[0];
    const props = toMermaidShapeElementProps(
      node,
      ownerBound,
      undefined,
      undefined,
      projectNeutralMermaidGfxNodeElement(node),
    );
    const members = node.details!.filter(
      (detail) => detail.kind !== "separator",
    );
    expect(members.map((detail) => detail.label)).toEqual([
      "+title",
      "+exportPdf()",
    ]);
    expect(JSON.parse(String(props.mermaidNodeDetails))).toEqual(node.details);
    expect(new Set(members.map((detail) => detail.sourceKey)).size).toBe(2);
    expect(props).toMatchObject({
      mermaidNodeDisplayLabel: "Document",
      mermaidNodeLabel: "Document",
      text: "Document",
    });
    const detailEntries = getMermaidVisualNodeDetailElementEntries(model);
    expect(
      detailEntries.filter(({ detail }) => detail.kind !== "separator"),
    ).toHaveLength(2);
    const detailProps = detailEntries.map(({ detail, node }) =>
      toMermaidNodeDetailElementProps({
        detail,
        ownerBound,
        node,
        projection: typeOwnedMermaidNodeDetailElementProjection(
          model,
          node,
          detail,
        )!,
      }),
    );
    expect(detailProps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mermaidDetailId: members[0].id,
          mermaidDetailKind: "field",
          mermaidDetailOwnerNodeId: node.id,
          mermaidDetailSourceKey: members[0].sourceKey,
          mermaidNodeId: node.id,
          mermaidRole: MERMAID_GFX_DETAIL_ROLE,
          text: "+title",
        }),
        expect.objectContaining({
          mermaidDetailId: members[1].id,
          mermaidDetailKind: "operation",
          mermaidDetailOwnerNodeId: node.id,
          mermaidDetailSourceKey: members[1].sourceKey,
          mermaidNodeId: node.id,
          mermaidRole: MERMAID_GFX_DETAIL_ROLE,
          text: "+exportPdf()",
        }),
      ]),
    );

    const roundtrip = createMermaidVisualModelFromGfxElements({
      diagramType: "classDiagram",
      direction: "TD",
      elements: [
        {
          id: "shape-Document",
          props,
          text: props.text,
          textAlign: props.textAlign,
          textVerticalAlign: props.textVerticalAlign,
          type: "shape",
          xywh: new Bound(node.x, node.y, node.width, node.height).serialize(),
        },
        ...detailEntries.map(({ elementId }, index) => ({
          id: elementId,
          props: detailProps[index],
          text:
            detailEntries[index].detail.id === members[1].id
              ? "+exportPdf(): File"
              : (detailProps[index]?.text as string),
          type: "shape" as const,
          xywh: detailProps[index]?.xywh as string,
        })),
      ],
      ownerBound,
      previousModel: model,
    });

    expect(
      roundtrip?.nodes[0]?.details?.filter(
        (detail) => detail.kind !== "separator",
      ),
    ).toEqual([members[0], { ...members[1], label: "+exportPdf(): File" }]);
    expect(
      generateMermaidSourceFromGfxVisualModel(
        "classDiagram\n  class Document {\n    +title\n    +exportPdf()\n  }\n",
        roundtrip!,
      ),
    ).toBe(
      "classDiagram\n  class Document {\n    +title\n    +exportPdf()\n  }\n".replace(
        "+exportPdf()",
        "+exportPdf(): File",
      ),
    );

    const partiallyMaterialized = createMermaidVisualModelFromGfxElements({
      diagramType: "classDiagram",
      direction: "TD",
      elements: [
        {
          id: "shape-Document",
          props,
          text: props.text,
          type: "shape",
          xywh: new Bound(node.x, node.y, node.width, node.height).serialize(),
        },
        {
          id: detailEntries[0]!.elementId,
          props: detailProps[0],
          text: detailProps[0]!.text as string,
          type: "shape",
          xywh: detailProps[0]!.xywh as string,
        },
      ],
      ownerBound,
      previousModel: model,
    });
    expect(
      generateMermaidSourceFromGfxVisualModel(
        "classDiagram\n  class Document {\n    +title\n    +exportPdf()\n  }\n",
        partiallyMaterialized!,
      ),
    ).toContain("    +exportPdf()");
  });

  test("projects Relationship edges as direct semantic connectors", () => {
    const classParsed = parseMermaidSourceToGfxVisualModel(
      "classDiagram-v2\n  Document <|-- Export : specializes\n",
    );
    expect(classParsed.model?.edges[0]).toMatchObject({
      connectorMode: "straight",
      label: "specializes",
      labelPlacement: "top",
    });
    expect(classEdgeGfxData(classParsed.model!.edges[0]!)).toMatchObject({
      relationKind: "<|--",
    });

    const erParsed = parseMermaidSourceToGfxVisualModel(
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
    );
    expect(erParsed.model?.edges[0]).toMatchObject({
      connectorMode: "orthogonal",
      sourceMarker: "double-bar",
      targetMarker: "circle-crow-foot",
      label: "places",
      labelPlacement: "top",
    });
    expect(erEdgeGfxData(erParsed.model!.edges[0]!)).toMatchObject({
      cardinalityA: "exactly-one",
      cardinalityB: "zero-or-many",
      identification: "--",
    });

    const requirementParsed = parseMermaidSourceToGfxVisualModel(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Export works\n  }\n  element doc1 {\n    type: document\n  }\n  req1 - verifies -> doc1\n",
    );
    expect(requirementParsed.model?.edges[0]).toMatchObject({
      connectorMode: "orthogonal",
      labelPlacement: "center",
    });
    expect(
      requirementEdgeGfxData(requirementParsed.model!.edges[0]),
    ).toMatchObject({ relationKind: "verifies" });
  });

  test("returns source-only state for unsupported family syntax", () => {
    const parsed = mermaidErFamily.parseSource(
      "sequenceDiagram\n  Alice->>Bob: Hi\n",
      "sequenceDiagram",
    );
    const state = mermaidErFamily.toVisualModel(parsed);

    expect(parsed.model).toBeNull();
    expect(parsed.diagnostics[0]?.code).toBe("missing-header");
    expect(state.kind).toBe("source-only");
  });
});
