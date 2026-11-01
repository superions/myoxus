// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceValuePatch,
  type SourceYaml,
} from "../source-yaml.js";
import type {
  JourneySourceDocument,
  JourneySourceRecord,
} from "./source-document.js";

/** Native 11.17.2 drawTasks, legend and SVG-bounds geometry fields.
 * boxMargin only reads an always-empty sequenceItems collection in this renderer.
 * width/height/taskMargin place tasks; margins and leftMargin set SVG bounds;
 * maxLabelWidth/boxTextMargin affect actor legend wrapping/placement.
 * useMaxWidth and textPlacement are effective native Base/layout options.
 * noteMargin, messageMargin/messageAlign, bottomMarginAdj, rightAngles and
 * activationWidth are accepted but unread here. Actor/section/title palettes,
 * task/title font fields are theme-owned, so none become local UI controls. */
export const JOURNEY_EFFECTIVE_GEOMETRY_FIELDS = [
  "diagramMarginX",
  "diagramMarginY",
  "leftMargin",
  "maxLabelWidth",
  "width",
  "height",
  "boxTextMargin",
  "taskMargin",
] as const;
export type JourneyConfigScope = {
  yaml: SourceYaml;
  prefix: string;
  record: JourneySourceRecord;
};
export function readJourneyConfig(source: JourneySourceDocument) {
  const scopes: JourneyConfigScope[] = [];
  const effective: Record<string, unknown> = {
    diagramMarginX: 50,
    diagramMarginY: 10,
    leftMargin: 150,
    maxLabelWidth: 90,
    width: 150,
    height: 50,
    boxMargin: 10,
    boxTextMargin: 5,
    taskMargin: 50,
    useMaxWidth: true,
  };
  const invalid: string[] = [];
  for (const record of source.records) {
    if (record.kind !== "frontmatter" && record.kind !== "directive") continue;
    if (
      record.kind === "directive" &&
      record.complete &&
      !/^%%\{\s*(?:init|initialize)\s*:/i.test(record.raw.trim())
    )
      continue;
    const start =
      record.kind === "frontmatter"
        ? (/\r\n|\r|\n/.exec(record.raw)?.index ?? 3) +
          (/\r\n|\r|\n/.exec(record.raw)?.[0].length ?? 0)
        : record.raw.indexOf("%%{") + 2;
    const end =
      record.kind === "frontmatter"
        ? record.raw.lastIndexOf("---")
        : record.raw.lastIndexOf("}%%") + 1;
    const yaml = record.complete
      ? readSourceYaml(record.raw.slice(start, end), record.range.start + start)
      : null;
    if (!yaml) {
      invalid.push(record.sourceKey);
      continue;
    }
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : "init" in yaml.values
          ? "init"
          : "initialize";
    const config = yaml.values[prefix];
    const journey =
      config && typeof config === "object" && "journey" in config
        ? config.journey
        : undefined;
    if (journey && typeof journey === "object" && !Array.isArray(journey))
      Object.assign(effective, journey);
    scopes.push({ yaml, prefix, record });
  }
  return { scopes, effective, invalid };
}
export function journeyConfigPatch(
  source: JourneySourceDocument,
  field: string,
  value: unknown,
): SourceValuePatch[] | null {
  if (!field || /[\r\n]/.test(field)) return null;
  if (
    JOURNEY_EFFECTIVE_GEOMETRY_FIELDS.includes(
      field as (typeof JOURNEY_EFFECTIVE_GEOMETRY_FIELDS)[number],
    ) &&
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      ((field === "width" || field === "height") && value === 0))
  )
    return null;
  const { scopes, invalid } = readJourneyConfig(source);
  if (invalid.length) return null;
  const scope =
    scopes.findLast((item) => {
      const config = item.yaml.values[item.prefix];
      return (
        config &&
        typeof config === "object" &&
        "journey" in config &&
        config.journey &&
        typeof config.journey === "object" &&
        field in config.journey
      );
    }) ?? scopes.at(-1);
  if (scope)
    return sourceYamlFieldPatch(
      scope.yaml,
      [scope.prefix, "journey", field],
      value,
    );
  if (value === undefined) return [];
  const header = source.records.find((item) => item.kind === "header");
  if (!header) return null;
  return [
    {
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify({ journey: { [field]: value } })}}%%${source.newline}`,
    },
  ];
}
