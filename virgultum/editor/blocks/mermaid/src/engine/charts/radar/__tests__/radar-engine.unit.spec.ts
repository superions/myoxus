// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { applyMermaidRadarFamilySourceCommand } from "../../../../families/charts/radar/source-application.js";
import { parseMermaidRadarSource } from "../parser.js";

const POSITIONAL_SOURCE = [
  "---",
  'title: "Readiness"',
  "config:",
  "  radar:",
  "    width: 760",
  "    height: 620",
  "---",
  "radar-beta :",
  "  %% Readiness review",
  "  accTitle: Operational readiness",
  "  axis Speed[\"Delivery velocity\"], Quality['Shared capability']",
  '  axis Cost["Cost efficiency"]',
  '  curve Current["Current profile"] {4, 5, 6}',
  "  curve Target['Target profile'] {Cost: 8, Speed 7, Quality: 9}",
  "  showLegend false, ticks 7, max 10",
  "  ticks 6, min 1, graticule polygon",
].join("\n");

function apply(
  source: string,
  model: NonNullable<ReturnType<typeof parseMermaidRadarSource>>,
  command: Parameters<
    typeof applyMermaidRadarFamilySourceCommand
  >[0]["command"],
) {
  const result = applyMermaidRadarFamilySourceCommand({
    baseSourceHash: model.sourceHash,
    command,
    model,
    source,
  });
  expect(result.changed, result.diagnosis).toBe(true);
  return result;
}

describe("Radar source engine", () => {
  test("preserves source forms and trivia while commands patch only their owners", () => {
    const initial = parseMermaidRadarSource(POSITIONAL_SOURCE)!;
    expect(initial.axes.map(({ label, name }) => [name, label])).toEqual([
      ["Speed", "Delivery velocity"],
      ["Quality", "Shared capability"],
      ["Cost", "Cost efficiency"],
    ]);
    expect(
      initial.curves.map(({ name, sourceForm }) => [name, sourceForm]),
    ).toEqual([
      ["Current", "positional"],
      ["Target", "detailed"],
    ]);
    expect(initial.options.explicit.ticks).toBe(6);
    expect(initial.options.effective).toMatchObject({
      graticule: "polygon",
      maximum: 10,
      minimum: 1,
      showLegend: false,
      ticks: 6,
    });

    const quality = initial.axes.find(({ name }) => name === "Quality")!;
    const labelled = apply(POSITIONAL_SOURCE, initial, {
      axisId: quality.id,
      label: "Product quality",
      type: "axis.label",
    });
    const current = labelled.model.curves.find(
      ({ name }) => name === "Current",
    )!;
    const speedVertex = current.vertices.find(
      ({ axisId }) =>
        labelled.model.axes.find(({ id }) => id === axisId)?.name === "Speed",
    )!;
    const valued = apply(labelled.source, labelled.model, {
      entryId: speedVertex.entryId!,
      type: "vertex.value",
      value: 5,
    });
    const optioned = apply(valued.source, valued.model, {
      graticule: "polygon",
      max: 10,
      min: 1,
      showLegend: false,
      ticks: 8,
      type: "options.apply",
    });

    expect(optioned.source).toBe(
      POSITIONAL_SOURCE.replace(
        "Quality['Shared capability']",
        "Quality['Product quality']",
      )
        .replace("{4, 5, 6}", "{5, 5, 6}")
        .replace("ticks 6, min 1", "ticks 8, min 1"),
    );
    expect(
      optioned.model.curves[1].entries.map(({ axisName, value }) => [
        axisName,
        value,
      ]),
    ).toEqual([
      ["Cost", 8],
      ["Speed", 7],
      ["Quality", 9],
    ]);

    const shifted = parseMermaidRadarSource(
      optioned.source.replace(
        "  accTitle: Operational readiness",
        "  accTitle: Operational readiness\n  accDescr: Current and target",
      ),
      optioned.model,
    )!;
    expect(shifted.axes.map(({ id }) => id)).toEqual(
      optioned.model.axes.map(({ id }) => id),
    );
    expect(shifted.curves.map(({ id }) => id)).toEqual(
      optioned.model.curves.map(({ id }) => id),
    );
  });

  test("keeps detailed references and invalid raw recovery locally repairable", () => {
    const validSource = POSITIONAL_SOURCE.replace("ticks 6", "ticks 5");
    const valid = parseMermaidRadarSource(validSource)!;
    const invalidSource = validSource
      .replace("ticks 5", "ticks nope")
      .replace("width: 760", "width: broken");
    const recovered = parseMermaidRadarSource(invalidSource, valid)!;

    expect(recovered.options.effective.ticks).toBe(5);
    expect(recovered.config.width).toBe(760);
    expect(recovered.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["invalid-config", "invalid-option"]),
    );
    const invalidTick = recovered.sourceDocument.records
      .flatMap((record) => (record.kind === "options" ? record.options : []))
      .find((option) => option.name === "ticks" && !option.valid)!;
    expect(
      invalidSource.slice(
        invalidTick.valueRange.start,
        invalidTick.valueRange.end,
      ),
    ).toBe("nope");

    const repairedOptions = apply(invalidSource, recovered, {
      graticule: "polygon",
      max: 10,
      min: 1,
      showLegend: false,
      ticks: 5,
      type: "options.apply",
    });
    expect(repairedOptions.source).toBe(
      invalidSource.replace("ticks nope", "ticks 5"),
    );
    const target = repairedOptions.model.curves.find(
      ({ name }) => name === "Target",
    )!;
    const positional = apply(repairedOptions.source, repairedOptions.model, {
      curveId: target.id,
      form: "positional",
      type: "curve.form",
    });
    expect(positional.source).toContain(
      "curve Target['Target profile'] {7, 9, 8}",
    );
    expect(positional.source).toContain("width: broken");
    expect(
      positional.model.curves.find(({ name }) => name === "Target")!,
    ).toMatchObject({ sourceForm: "positional" });
  });
});
