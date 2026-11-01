// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarConfig,
  MermaidRadarModel,
  MermaidRadarOptionName,
} from "@virgultum/block-mermaid";

function sourceSlice(
  model: MermaidRadarModel,
  range: { readonly end: number; readonly start: number },
) {
  return model.sourceDocument.source.slice(range.start, range.end);
}

export function radarOptionSourceValue(
  model: MermaidRadarModel,
  name: MermaidRadarOptionName,
) {
  let value: string | undefined;
  for (const record of model.sourceDocument.records) {
    if (record.kind !== "options") continue;
    for (const option of record.options) {
      if (option.name === name) value = sourceSlice(model, option.valueRange);
    }
  }
  return value;
}

export function radarOptionsSourceKey(model: MermaidRadarModel) {
  return JSON.stringify(
    Object.fromEntries(
      (["showLegend", "ticks", "min", "max", "graticule"] as const).map(
        (name) => [name, radarOptionSourceValue(model, name)],
      ),
    ),
  );
}

export function radarConfigSourceValue(
  model: MermaidRadarModel,
  field: keyof Required<MermaidRadarConfig>,
) {
  let value: string | undefined;
  for (const record of model.sourceDocument.records) {
    if (record.kind !== "frontmatter" && record.kind !== "directive") continue;
    for (const candidate of record.configFields) {
      if (candidate.field === field)
        value = sourceSlice(model, candidate.valueRange);
    }
  }
  return value;
}

export function radarConfigSourceKey(model: MermaidRadarModel) {
  return JSON.stringify(
    Object.fromEntries(
      (
        [
          "useMaxWidth",
          "width",
          "height",
          "marginTop",
          "marginRight",
          "marginBottom",
          "marginLeft",
          "axisScaleFactor",
          "axisLabelFactor",
          "curveTension",
        ] as const
      ).map((field) => [field, radarConfigSourceValue(model, field)]),
    ),
  );
}
