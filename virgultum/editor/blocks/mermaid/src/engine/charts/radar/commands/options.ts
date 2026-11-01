// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommandContext,
  MermaidRadarOptionsCommand,
} from "./types.js";
import { validRadarValue } from "./types.js";
import {
  mermaidRadarNumber,
  radarInsertionPatch,
  radarNoChange,
  radarPatchedResult,
  radarRecordRemovalPatch,
  radarRemovalRange,
  type MermaidRadarSourcePatch,
} from "../writer.js";
import type { MermaidRadarOptionName } from "../source-document.js";
import { DEFAULT_MERMAID_RADAR_OPTIONS } from "../model.js";

export function mermaidRadarOptionsDiagnosis(
  model: MermaidRadarCommandContext["model"],
  command: MermaidRadarOptionsCommand,
) {
  if (!validRadarValue(command.ticks)) return "radar.options.ticks";
  if (!validRadarValue(command.min)) return "radar.options.min";
  if (command.max !== null && !validRadarValue(command.max))
    return "radar.options.max";
  if (command.max !== null && command.max <= command.min)
    return "radar.options.range";
  const autoMaximum = Math.max(
    ...model.curves.flatMap((curve) =>
      curve.entries
        .filter((entry) => entry.status === "resolved")
        .map((entry) => entry.value),
    ),
    Number.NEGATIVE_INFINITY,
  );
  if (
    command.max === null &&
    (!Number.isFinite(autoMaximum) || autoMaximum <= command.min)
  )
    return "radar.options.range";
  return null;
}

function removeAllOptionOccurrences(
  context: MermaidRadarCommandContext,
  name: MermaidRadarOptionName,
): MermaidRadarSourcePatch[] | null {
  const optionRecords = context.model.sourceDocument.records.filter(
    (record) =>
      record.kind === "options" &&
      record.options.some((option) => option.name === name),
  );
  if (
    optionRecords.some(
      (record) => record.kind === "options" && !record.complete,
    )
  )
    return null;
  const ranges = optionRecords.flatMap((record) => {
    if (record.kind !== "options") return [];
    const retained = record.options.filter((option) => option.name !== name);
    if (retained.length === 0) {
      const anchoredComments = context.model.comments.some(
        (comment) =>
          comment.anchor.kind === "options" && comment.anchor.id === record.id,
      );
      if (anchoredComments) return [null];
      return [radarRecordRemovalPatch(context.model, record).range];
    }
    return record.options
      .filter((option) => option.name === name)
      .map((option) => radarRemovalRange(record, option, record.options));
  });
  if (ranges.some((range) => range === null)) return null;
  return ranges
    .filter((range): range is NonNullable<typeof range> => range !== null)
    .sort((left, right) => left.start - right.start)
    .reduce<Array<MermaidRadarSourcePatch["range"]>>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) {
        merged[merged.length - 1] = {
          ...previous,
          end: Math.max(previous.end, range.end),
        };
        return merged;
      }
      return [...merged, range];
    }, [])
    .map((range) => ({ range, value: "" }));
}

function optionRemovalHasAnchoredComments(
  context: MermaidRadarCommandContext,
  name: MermaidRadarOptionName,
) {
  return context.model.sourceDocument.records.some(
    (record) =>
      record.kind === "options" &&
      record.options.length > 0 &&
      record.options.every((option) => option.name === name) &&
      context.model.comments.some(
        (comment) =>
          comment.anchor.kind === "options" && comment.anchor.id === record.id,
      ),
  );
}

export function applyMermaidRadarOptionsCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarOptionsCommand;
  const { model, source } = context;
  if (command.type !== "options.apply")
    return radarNoChange(model, source, "radar.options-invalid");
  const diagnosis = mermaidRadarOptionsDiagnosis(model, command);
  if (diagnosis) return radarNoChange(model, source, diagnosis);
  const values: Record<MermaidRadarOptionName, string | null> = {
    graticule: command.graticule,
    max: command.max === null ? null : mermaidRadarNumber(command.max),
    min: mermaidRadarNumber(command.min),
    showLegend: String(command.showLegend),
    ticks: mermaidRadarNumber(command.ticks),
  };
  const sourceValues: Record<
    MermaidRadarOptionName,
    boolean | number | string | null
  > = {
    graticule:
      model.options.explicit.graticule ??
      DEFAULT_MERMAID_RADAR_OPTIONS.graticule,
    max: model.options.explicit.max ?? null,
    min: model.options.explicit.min ?? DEFAULT_MERMAID_RADAR_OPTIONS.min,
    showLegend:
      model.options.explicit.showLegend ??
      DEFAULT_MERMAID_RADAR_OPTIONS.showLegend,
    ticks: model.options.explicit.ticks ?? DEFAULT_MERMAID_RADAR_OPTIONS.ticks,
  };
  const desiredValues: Record<
    MermaidRadarOptionName,
    boolean | number | string | null
  > = {
    graticule: command.graticule,
    max: command.max,
    min: command.min,
    showLegend: command.showLegend,
    ticks: command.ticks,
  };
  const decisions = (Object.keys(values) as MermaidRadarOptionName[]).map(
    (name) => {
      const records = model.sourceDocument.records.flatMap((record) =>
        record.kind === "options"
          ? record.options
              .filter((option) => option.name === name)
              .map((option) => ({ option, record }))
          : [],
      );
      const occurrence = records.at(-1);
      if (values[name] === null) {
        const patches = removeAllOptionOccurrences(context, name);
        return {
          commentsPresent:
            patches === null && optionRemovalHasAnchoredComments(context, name),
          invalid: patches === null,
          missing: false,
          patches: patches ?? [],
        };
      }
      return occurrence
        ? {
            invalid: false,
            missing: false,
            patches:
              source.slice(
                occurrence.option.valueRange.start,
                occurrence.option.valueRange.end,
              ) === values[name]
                ? []
                : [
                    {
                      range: occurrence.option.valueRange,
                      value: values[name]!,
                    } satisfies MermaidRadarSourcePatch,
                  ],
          }
        : {
            invalid: false,
            missing: sourceValues[name] !== desiredValues[name],
            name,
            patches: [],
          };
    },
  );
  if (decisions.some((decision) => decision.invalid))
    return radarNoChange(
      model,
      source,
      decisions.some((decision) => "commentsPresent" in decision)
        ? "radar.options-comments-present"
        : "radar.options-ambiguous",
    );
  const missing = decisions.flatMap<MermaidRadarOptionName>((decision) =>
    decision.missing && "name" in decision && decision.name
      ? [decision.name]
      : [],
  );
  const insertion =
    missing.length > 0
      ? radarInsertionPatch(
          model,
          `  ${missing.map((name) => `${name} ${values[name]}`).join(", ")}`,
          ["header", "metadata", "axis", "curve", "options"],
        )
      : null;
  const patches = [
    ...decisions.flatMap((decision) => decision.patches),
    ...(insertion ? [insertion] : []),
  ];
  return radarPatchedResult({
    model,
    patches,
    selectionAfter: null,
    source,
  });
}
