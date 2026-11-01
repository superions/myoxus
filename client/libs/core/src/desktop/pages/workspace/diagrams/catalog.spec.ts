import { describe, expect, test } from "vitest";

import {
  DIAGRAM_CATALOG,
  getDiagramCatalogEntries,
  getDiagramCatalogMaturity,
  recentDiagramDocs,
} from "./catalog";

describe("diagram catalog contracts", () => {
  test("exposes every semantic Mermaid type once plus first-class BPMN", () => {
    expect(
      DIAGRAM_CATALOG.filter(({ format }) => format === "bpmn"),
    ).toHaveLength(1);
    expect(new Set(DIAGRAM_CATALOG.map(({ id }) => id)).size).toBe(
      DIAGRAM_CATALOG.length,
    );
    expect(
      DIAGRAM_CATALOG.every(
        (entry) => entry.format !== "mermaid" || Boolean(entry.source.trim()),
      ),
    ).toBe(true);
    expect(getDiagramCatalogEntries("popular").length).toBeGreaterThan(0);
  });

  test("marks only the seven source-only catalog dialects", () => {
    const mermaidEntries = DIAGRAM_CATALOG.filter(
      ({ format }) => format === "mermaid",
    );
    expect(
      mermaidEntries.filter(({ sourceOnly }) => sourceOnly).map(({ id }) => id),
    ).toEqual([
      "swimlanes",
      "event-modeling",
      "tree-view",
      "wardley",
      "cynefin",
      "ishikawa",
      "venn",
    ]);
    expect(mermaidEntries.filter(({ sourceOnly }) => !sourceOnly)).toHaveLength(
      22,
    );
    expect(mermaidEntries.find(({ id }) => id === "kanban")?.sourceOnly).toBe(
      undefined,
    );
    expect(DIAGRAM_CATALOG.find(({ id }) => id === "bpmn")?.sourceOnly).toBe(
      undefined,
    );
  });

  test("keeps Flowchart in Beta and every other catalog type in Alpha", () => {
    expect(
      DIAGRAM_CATALOG.filter(
        ({ id }) => getDiagramCatalogMaturity(id) === "beta",
      ).map(({ id }) => id),
    ).toEqual(["flowchart"]);
    expect(
      DIAGRAM_CATALOG.every(
        ({ id }) =>
          id === "flowchart" || getDiagramCatalogMaturity(id) === "alpha",
      ),
    ).toBe(true);
  });

  test("returns at most ten diagrams in descending activity order", () => {
    const docs = Array.from({ length: 12 }, (_, index) => ({
      id: `diagram-${index}`,
      meta$: { value: { updatedDate: index } },
    }));

    expect(recentDiagramDocs(docs).map(({ id }) => id)).toEqual([
      "diagram-11",
      "diagram-10",
      "diagram-9",
      "diagram-8",
      "diagram-7",
      "diagram-6",
      "diagram-5",
      "diagram-4",
      "diagram-3",
      "diagram-2",
    ]);
  });
});
