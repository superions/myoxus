// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { applyMermaidQuadrantSourceCommand } from "../writer.js";
import { parseMermaidQuadrantSource } from "../parser.js";

const SOURCE = `---
config:
  quadrantChart:
    chartWidth: 720
---
%%{init: {"quadrantChart": {"chartHeight": 520}}}%%
quadrantChart
  title Product portfolio
  accTitle: Accessible portfolio
  accDescr {
    Eight initiatives.
  }
  x-axis Low --> High
  y-axis Easy -->
  quadrant-1 Strategic bets
  quadrant-2 Quick wins
  quadrant-3 Defer
  quadrant-4 Maintenance
  classDef priority radius: 9, color: #5B8DEF, stroke-color: #264A8A, stroke-width: 2px

  %% first duplicate remains anchored
  Duplicate:::priority: [0.25, 0.75]
  Duplicate: [0.72, 0.82]
  "\`Long **markdown** label\`": [1, 0] radius: 8, color: #A778E8
`;

describe("Mermaid Quadrant engine owner", () => {
  test("parses the installed grammar into ordered, lossless source records", () => {
    const model = parseMermaidQuadrantSource(SOURCE);

    expect(model).not.toBeNull();
    expect(model?.diagnostics).toEqual([]);
    expect(model?.sourceDocument.source).toBe(SOURCE);
    expect(model?.config).toMatchObject({ chartHeight: 520, chartWidth: 720 });
    expect(model?.axes.y.form).toBe("left-open");
    expect(model?.points.map(({ label }) => label)).toEqual([
      "Duplicate",
      "Duplicate",
      "Long **markdown** label",
    ]);
    expect(new Set(model?.points.map(({ id }) => id)).size).toBe(3);
    expect(model?.comments[0]?.anchor).toMatchObject({
      id: model?.points[0]?.id,
      kind: "point",
    });
  });

  test("patches only the commanded duplicate and preserves its identity", () => {
    const model = parseMermaidQuadrantSource(SOURCE)!;
    const target = model.points[1];
    const moved = applyMermaidQuadrantSourceCommand({
      baseSourceHash: model.sourceHash,
      command: { pointId: target.id, type: "point.move", x: 0.5, y: 0.1 },
      previousModel: model,
      source: SOURCE,
    });

    expect(moved.changed).toBe(true);
    expect(moved.patches).toHaveLength(2);
    expect(moved.source).toContain("Duplicate: [0.5, 0.1]");
    expect(moved.source).toContain("Duplicate:::priority: [0.25, 0.75]");
    expect(moved.source).toContain("%% first duplicate remains anchored");
    expect(moved.model.points[1]?.id).toBe(target.id);
    expect(moved.model.sourceDocument.source).toBe(moved.source);
  });

  test("rejects stale and invalid commands without source or history work", () => {
    const model = parseMermaidQuadrantSource(SOURCE)!;
    const target = model.points[0];
    const invalid = applyMermaidQuadrantSourceCommand({
      command: { pointId: target.id, type: "point.move", x: 2, y: 0.5 },
      previousModel: model,
      source: SOURCE,
    });
    const stale = applyMermaidQuadrantSourceCommand({
      baseSourceHash: "stale",
      command: { label: "Changed", pointId: target.id, type: "point.rename" },
      previousModel: model,
      source: SOURCE,
    });

    expect(invalid).toMatchObject({
      changed: false,
      patches: [],
      source: SOURCE,
    });
    expect(stale).toMatchObject({
      changed: false,
      patches: [],
      source: SOURCE,
    });
  });
});
