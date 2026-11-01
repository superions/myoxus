// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { computeDataSankeyLayout } from "./sankey-layout";

const nodes = ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase() }));

describe("Sankey layout", () => {
  test.each(["left", "right", "center", "justify"] as const)(
    "projects finite %s geometry without remapping the alignment",
    (alignment) => {
      const layout = computeDataSankeyLayout({
        alignment,
        height: 400,
        links: [
          { id: "ab", sourceId: "a", targetId: "b", value: 8 },
          { id: "ac", sourceId: "a", targetId: "c", value: 2 },
        ],
        nodePadding: 12,
        nodeWidth: 10,
        nodes,
        width: 600,
      });

      expect(layout.links.map(({ id }) => id)).toEqual(["ab", "ac"]);
      expect(
        [...layout.nodes, ...layout.links].every((item) =>
          Object.values(item).every(
            (value) => typeof value !== "number" || Number.isFinite(value),
          ),
        ),
      ).toBe(true);
      expect(layout.nodes.find(({ id }) => id === "a")!.x0).toBeLessThan(
        layout.nodes.find(({ id }) => id === "b")!.x0,
      );
    },
  );

  test("uses finite layout-only weights while preserving an all-zero graph", () => {
    const layout = computeDataSankeyLayout({
      alignment: "justify",
      height: 400,
      links: [
        { id: "ab", sourceId: "a", targetId: "b", value: 0 },
        { id: "bc", sourceId: "b", targetId: "c", value: 0 },
      ],
      nodePadding: 12,
      nodeWidth: 10,
      nodes,
      width: 600,
    });

    expect(layout.links.map(({ value, width }) => [value, width])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(layout.nodes.map(({ value }) => value)).toEqual([0, 0, 0]);
    expect(
      layout.nodes.every(({ x0, x1, y0, y1 }) =>
        [x0, x1, y0, y1].every(Number.isFinite),
      ),
    ).toBe(true);
  });
});
