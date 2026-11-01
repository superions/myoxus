import { describe, expect, test } from "vitest";

import {
  computeDataTreemapLayout,
  DATA_TREEMAP_SECTION_HEADER,
} from "./treemap-layout";
import { d3ChartNumberFormatter } from "./chart-shell";

describe("Treemap layout", () => {
  test("keeps value geometry, section insets and zero-area bounds honest", () => {
    const layout = computeDataTreemapLayout({
      data: [
        {
          id: "root",
          label: "Root",
          sourceOrder: 0,
          type: "section",
          value: 0,
          children: [
            {
              id: "small",
              label: "Small",
              sourceOrder: 0,
              type: "leaf",
              value: 1,
            },
            {
              id: "large",
              label: "Large",
              sourceOrder: 1,
              type: "leaf",
              value: 9,
            },
            {
              id: "zero",
              label: "Zero",
              sourceOrder: 2,
              type: "leaf",
              value: 0,
            },
          ],
        },
      ],
      width: 1000,
      height: 400,
      diagramPadding: 8,
      padding: 10,
    });
    const byId = new Map(layout.map((node) => [node.id, node]));
    const area = (id: string) => {
      const node = byId.get(id)!;
      return (node.x1 - node.x0) * (node.y1 - node.y0);
    };

    expect(area("large")).toBeGreaterThan(area("small"));
    expect(area("zero")).toBe(0);
    expect(byId.get("small")!.y0).toBeGreaterThanOrEqual(
      byId.get("root")!.y0 + DATA_TREEMAP_SECTION_HEADER,
    );
    for (const node of layout) {
      expect([node.x0, node.x1, node.y0, node.y1].every(Number.isFinite)).toBe(
        true,
      );
      expect(node.x0).toBeGreaterThanOrEqual(0);
      expect(node.y0).toBeGreaterThanOrEqual(0);
      expect(node.x1).toBeLessThanOrEqual(1000);
      expect(node.y1).toBeLessThanOrEqual(400);
    }
  });

  test("matches Mermaid's accepted currency format and invalid fallback", () => {
    expect(d3ChartNumberFormatter("$0,0")(12345)).toBe("$12,345");
    expect(d3ChartNumberFormatter("not a format")(12345)).toBe("12,345");
  });
});
