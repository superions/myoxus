import { describe, expect, test } from "vitest";

import {
  isMermaidProductDiagramType,
  MERMAID_PRODUCT_DIAGRAM_TYPES,
} from "../../engine/product-types.js";
import {
  getMermaidFamilyRuntime,
  getMermaidFamilyRuntimes,
  resolveMermaidFamilyRuntime,
} from "../runtime/registry.js";
import { getMermaidGfxFamilyHooksForDiagramType } from "../runtime/gfx-family-hooks-registry.js";
import {
  getMermaidFamilyDiagramCapability,
  isMermaidFamilyVisualEditingDiagramType,
} from "../registry.js";

describe("Mermaid family registry", () => {
  test("registers each executable family owner once", () => {
    expect(
      new Set(getMermaidFamilyRuntimes().map((runtime) => runtime.id)).size,
    ).toBe(getMermaidFamilyRuntimes().length);
  });

  test("keeps GFX hooks owned by exactly their runtime registrations", () => {
    expect(getMermaidGfxFamilyHooksForDiagramType("architecture")).toBeTruthy();
    expect(getMermaidGfxFamilyHooksForDiagramType("flowchart")).toBeTruthy();
    expect(getMermaidGfxFamilyHooksForDiagramType("classDiagram")).toBeTruthy();
    expect(getMermaidGfxFamilyHooksForDiagramType("stateDiagram")).toBeTruthy();
    expect(getMermaidGfxFamilyHooksForDiagramType("packet")).toBeNull();
  });

  test("covers every product diagram type exactly once", () => {
    const covered = new Map<string, string[]>();

    for (const family of getMermaidFamilyRuntimes()) {
      expect(family.diagramTypes.length, family.id).toBeGreaterThan(0);
      for (const diagramType of family.diagramTypes) {
        expect(isMermaidProductDiagramType(diagramType), diagramType).toBe(
          true,
        );
        covered.set(diagramType, [
          ...(covered.get(diagramType) ?? []),
          family.id,
        ]);
      }
    }

    expect([...covered.keys()].sort()).toEqual(
      [...MERMAID_PRODUCT_DIAGRAM_TYPES].sort(),
    );

    for (const diagramType of MERMAID_PRODUCT_DIAGRAM_TYPES) {
      expect(covered.get(diagramType), diagramType).toHaveLength(1);
      expect(getMermaidFamilyRuntime(diagramType)?.diagramTypes).toContain(
        diagramType,
      );
    }
  });

  test("resolves every inventory type through exactly one executable family", () => {
    for (const diagramType of MERMAID_PRODUCT_DIAGRAM_TYPES) {
      const family = getMermaidFamilyRuntime(diagramType);
      expect(family, diagramType).toBeTruthy();
      expect(family?.diagramTypes, diagramType).toContain(diagramType);
    }
  });

  test("keeps unknown types out of visual-editing gates", () => {
    expect(isMermaidFamilyVisualEditingDiagramType("unknown")).toBe(false);
  });

  test("exposes family-aware visual editing capability for host surfaces", () => {
    for (const [diagramType, familyId] of [
      ["architecture", "architecture"],
      ["flowchart", "flowchart"],
      ["gantt", "gantt"],
      ["pie", "pie"],
      ["xychart", "xy"],
      ["classDiagram", "class"],
      ["stateDiagram", "state"],
      ["block", "block"],
    ] as const) {
      expect(getMermaidFamilyDiagramCapability(diagramType)).toMatchObject({
        diagramType,
        familyId,
        reason: null,
        visualEditing: true,
      });
    }
    expect(getMermaidFamilyDiagramCapability("unknown")).toMatchObject({
      diagramType: "unknown",
      familyId: null,
      visualEditing: false,
    });
  });

  test("dispatches approved visual families through the sole runtime", () => {
    for (const source of [
      "flowchart TD\n  A[Start]\n  A --> B[Done]\n",
      "gantt\n  title Release\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :done, design, 2026-01-01, 2d\n",
      "xychart-beta\n  x-axis [A, B]\n  bar Actual [1, 2]\n",
      "sankey\n  Source, Process, 3\n  Process, Done, 1\n",
      'treemap-beta\n"Root"\n  "A": 3\n  "B": 1\n',
      "timeline\n  title Release\n  2026 : Launch\n",
      "kanban\n  todo[To Do]\n    task[Task]\n",
    ]) {
      expect(resolveMermaidFamilyRuntime(source).kind, source).toBe("resolved");
    }

    const kanban = "kanban\n  todo[To Do]\n    task[Task]\n  [Unclosed\n";
    expect(resolveMermaidFamilyRuntime(kanban)).toMatchObject({
      diagramType: "kanban",
      kind: "resolved",
      source: kanban,
      structuredModel: { ambiguous: true, cards: [], columns: [] },
    });
  });
});
