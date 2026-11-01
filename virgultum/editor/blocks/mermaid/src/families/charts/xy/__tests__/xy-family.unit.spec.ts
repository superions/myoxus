// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { parseMermaidXySource } from "../../../../engine/charts/xy/parser.js";
import type { MermaidXyCommand } from "../../../../engine/charts/xy/commands/types.js";
import { applyMermaidXyFamilySourceCommand } from "../source-application.js";

const BAND_SOURCE = `%%{init: {"xyChart": {"showDataLabel": true}}}%%
xychart-beta horizontal
  accTitle: Quarterly revenue chart
  %% Quarterly revenue source reviewed
  title "Revenue"
  x-axis [Jan, "April", Feb, "Q4"]
  y-axis "Revenue (USD)" 0 --> 10
  %% Revenue axis uses a fixed USD range
  bar "Expenses" [3, 4.5, 6, 8]
  %% Expenses remain below revenue
  line "Revenue trend" [5.5 "Kickoff", 7, 9.1, 9.5, 7.7]
`;

function apply(
  source: string,
  command: MermaidXyCommand,
  previousModel = parse(source),
) {
  const result = applyMermaidXyFamilySourceCommand({
    baseSourceHash: previousModel.sourceHash,
    command,
    model: previousModel,
    source,
  });
  expect(result.diagnosis.code).toBe("xy.ok");
  expect(result.changed).toBe(true);
  return result;
}

function parse(source: string) {
  const model = parseMermaidXySource(source);
  expect(model).not.toBeNull();
  return model!;
}

describe("Mermaid XY family source contract", () => {
  test("patches exact point and plot ranges while preserving trivia, unequal lengths and identities", () => {
    const initial = parse(BAND_SOURCE);
    const plotId = initial.plots[0]!.id;
    const pointId = initial.plots[0]!.points[2]!.id;
    const linePlotId = initial.plots[1]!.id;
    const linePointIds = initial.plots[1]!.points.map((point) => point.id);

    expect(initial.headerForm).toBe("xychart-beta");
    expect(initial.orientation).toBe("horizontal");
    expect(initial.xAxis.categories.map((category) => category.label)).toEqual([
      "Jan",
      "April",
      "Feb",
      "Q4",
    ]);
    expect(initial.plots[1]!.points).toHaveLength(5);
    expect(initial.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "length-mismatch",
    );

    const value = apply(
      BAND_SOURCE,
      {
        pointId,
        type: "point.value",
        value: 6.2,
      },
      initial,
    );
    expect(value.source).toBe(
      BAND_SOURCE.replace(
        'bar "Expenses" [3, 4.5, 6, 8]',
        'bar "Expenses" [3, 4.5, 6.2, 8]',
      ),
    );
    expect(value.model.plots[0]!.id).toBe(plotId);
    expect(value.model.plots[0]!.points[2]!.id).toBe(pointId);
    expect(value.model.plots[1]!.id).toBe(linePlotId);
    expect(value.model.plots[1]!.points.map((point) => point.id)).toEqual(
      linePointIds,
    );

    const renamed = apply(
      value.source,
      {
        plotId,
        title: "Operating expenses",
        type: "plot.rename",
      },
      value.model,
    );
    expect(renamed.source).toBe(
      value.source.replace('bar "Expenses"', 'bar "Operating expenses"'),
    );
    expect(renamed.source).toContain("%% Expenses remain below revenue");
    expect(renamed.model.plots[0]!.id).toBe(plotId);
    expect(renamed.model.plots[0]!.points[2]!.id).toBe(pointId);
  });

  test("reorders a band category and every paired value in one atomic source change", () => {
    const source = BAND_SOURCE.replace(
      'line "Revenue trend" [5.5 "Kickoff", 7, 9.1, 9.5, 7.7]',
      'line "Revenue trend" [5.5 "Kickoff", 7, 9.1, 9.5]',
    );
    const initial = parse(source);
    const q4 = initial.xAxis.categories[3]!;
    const april = initial.xAxis.categories[1]!;
    const initialPlotIds = initial.plots.map((plot) => plot.id);

    const result = apply(
      source,
      {
        beforeCategoryId: april.id,
        categoryId: q4.id,
        type: "category.reorder",
      },
      initial,
    );

    expect(result.source).toContain('x-axis [Jan, "Q4", "April", Feb]');
    expect(result.source).toContain('bar "Expenses" [3, 8, 4.5, 6]');
    expect(result.source).toContain(
      'line "Revenue trend" [5.5 "Kickoff", 9.5, 7, 9.1]',
    );
    expect(
      result.model.xAxis.categories.map((category) => category.id),
    ).toEqual([
      initial.xAxis.categories[0]!.id,
      q4.id,
      april.id,
      initial.xAxis.categories[2]!.id,
    ]);
    expect(result.model.plots.map((plot) => plot.id)).toEqual(initialPlotIds);
  });

  test("removes an explicit X model without emitting a naked axis or losing its comment", () => {
    const source = `xychart-beta
  x-axis "Quarter" [Q1, Q2] %% keep axis context
  bar Actual [1, 2]
`;
    const initial = parse(source);
    const result = apply(
      source,
      {
        confirmCategoryIds: initial.xAxis.categories.map(
          (category) => category.id,
        ),
        kind: "auto",
        type: "axis.x-model",
      },
      initial,
    );

    expect(result.source).toBe(`xychart-beta
  x-axis "Quarter" %% keep axis context
  bar Actual [1, 2]
`);
    expect(result.model.xAxis.sourceForm).toBe("title-only");

    const titleless = `xychart-beta
  x-axis [Q1, Q2] %% preserve this
  bar [1, 2]
`;
    const titlelessModel = parse(titleless);
    const omitted = apply(
      titleless,
      {
        confirmCategoryIds: titlelessModel.xAxis.categories.map(
          (category) => category.id,
        ),
        kind: "auto",
        type: "axis.x-model",
      },
      titlelessModel,
    );
    expect(omitted.source).toBe(`xychart-beta
  %% preserve this
  bar [1, 2]
`);
    expect(omitted.model.xAxis.sourceForm).toBe("omitted");
  });

  test("rejects stale and readonly writes without mutating the last valid model", () => {
    const initial = parse(BAND_SOURCE);
    const command: MermaidXyCommand = {
      pointId: initial.plots[0]!.points[0]!.id,
      type: "point.value",
      value: 4,
    };

    const stale = applyMermaidXyFamilySourceCommand({
      baseSourceHash: "stale",
      command,
      model: initial,
      source: BAND_SOURCE,
    });
    expect(stale).toMatchObject({
      changed: false,
      diagnosis: { code: "xy.stale-source" },
      model: initial,
      source: BAND_SOURCE,
    });

    const readonly = applyMermaidXyFamilySourceCommand({
      command,
      model: initial,
      readonly: true,
      source: BAND_SOURCE,
    });
    expect(readonly).toMatchObject({
      changed: false,
      diagnosis: { code: "xy.readonly" },
      model: initial,
      source: BAND_SOURCE,
    });
  });
});
