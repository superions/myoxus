// SPDX-License-Identifier: AGPL-3.0-or-later

import { isMap, isScalar, parseDocument, type Node, type YAMLMap } from "yaml";
import type {
  GanttSourceDocument,
  GanttSourceStatement,
} from "./source-document.js";
import type { GanttPatch } from "./writer.js";

export const GANTT_CONFIG_NUMBER_FIELDS = [
  "useWidth",
  "titleTopMargin",
  "barHeight",
  "barGap",
  "topPadding",
  "rightPadding",
  "leftPadding",
  "gridLineStartPadding",
  "fontSize",
  "sectionFontSize",
  "numberSectionStyles",
] as const;
export type GanttConfigNumberField =
  (typeof GANTT_CONFIG_NUMBER_FIELDS)[number];
export type GanttConfigField =
  GanttConfigNumberField | "displayMode" | "useMaxWidth";

export function isGanttConfigField(field: string): field is GanttConfigField {
  return (
    field === "displayMode" ||
    field === "useMaxWidth" ||
    (GANTT_CONFIG_NUMBER_FIELDS as readonly string[]).includes(field)
  );
}

export type GanttConfigOccurrence = {
  readonly field: string;
  readonly record: GanttSourceStatement;
  readonly scope: YAMLMap;
  readonly key: Node;
  readonly value: Node;
  readonly resolvedValue: unknown;
  readonly offset: number;
};

/** CST anchors keep unrelated config, comments and quoting byte-stable. */
export function readGanttConfig(source: GanttSourceDocument) {
  const occurrences: GanttConfigOccurrence[] = [];
  const scopes: { scope: YAMLMap; offset: number }[] = [];
  for (const record of source.statements) {
    if (record.kind !== "frontmatter" && record.kind !== "directive") continue;
    const start =
      record.kind === "frontmatter"
        ? (record.raw.match(/^[ \t]*---[ \t]*(?:\r\n|\r|\n)/)?.[0].length ?? 0)
        : record.raw.indexOf("%%{") + 2;
    const end =
      record.kind === "frontmatter"
        ? record.raw.lastIndexOf("---")
        : record.raw.lastIndexOf("}%%") + 1;
    const document = parseDocument(record.raw.slice(start, end), {
      keepSourceTokens: true,
      uniqueKeys: true,
      schema: "core",
    });
    if (document.errors.length) continue;
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : document.has("init")
          ? "init"
          : "initialize";
    const scope = document.getIn([prefix, "gantt"], true);
    if (!isMap(scope)) continue;
    let values: Record<string, unknown>;
    try {
      values = document.toJS({ maxAliasCount: 100 })?.[prefix]?.gantt ?? {};
    } catch {
      continue;
    }
    const offset = record.range.start + start;
    scopes.push({ scope, offset });
    for (const pair of scope.items) {
      if (!isScalar(pair.key) || !pair.key.range || !pair.value) continue;
      const value = pair.value as Node;
      if (!value.range) continue;
      const field = String(pair.key.value);
      occurrences.push({
        field,
        record,
        scope,
        key: pair.key,
        value,
        resolvedValue: values[field],
        offset,
      });
    }
  }
  const effective = Object.fromEntries(
    occurrences.map((item) => [item.field, item.resolvedValue]),
  );
  return { effective, occurrences, scopes };
}

/** Patch the selected occurrence (or effective property), without regenerating config. */
export function ganttConfigPatches(
  source: GanttSourceDocument,
  field: GanttConfigField,
  value: string | boolean | number | undefined,
  occurrence?: { readonly statementId: string },
): readonly GanttPatch[] | null {
  const { occurrences, scopes } = readGanttConfig(source);
  const existing = occurrence
    ? occurrences.find(
        (item) =>
          item.field === field && item.record.id === occurrence.statementId,
      )
    : occurrences.findLast((item) => item.field === field);
  if (occurrence && !existing) return null;
  if (existing) {
    if (value !== undefined)
      return [
        {
          range: {
            start: existing.offset + existing.value.range![0],
            end: existing.offset + existing.value.range![1],
          },
          value: JSON.stringify(value),
        },
      ];
    const index = existing.scope.items.findIndex(
      (pair) => pair.key === existing.key,
    );
    const start = existing.key.range![0];
    const end = existing.value.range![1];
    const patches: GanttPatch[] = [
      {
        range: { start: existing.offset + start, end: existing.offset + end },
        value: "",
      },
    ];
    if (existing.scope.flow && existing.scope.items.length > 1) {
      // Delete the separator token separately so comments between properties
      // stay intact, even when their text contains commas.
      const token = existing.scope.srcToken;
      const separator =
        token?.type === "flow-collection"
          ? token.items[
              index + 1 < existing.scope.items.length ? index + 1 : index
            ]?.start.find((item) => item.type === "comma")
          : undefined;
      if (!separator) return null;
      patches.push({
        range: {
          start: existing.offset + separator.offset,
          end: existing.offset + separator.offset + separator.source.length,
        },
        value: "",
      });
    }
    return patches;
  }
  if (value === undefined) return [];
  const scope = scopes.at(-1);
  const encoded = JSON.stringify(value);
  if (scope?.scope.range) {
    if (scope.scope.flow) {
      const end = scope.offset + scope.scope.range[1] - 1;
      return [
        {
          range: { start: end, end },
          value: `${scope.scope.items.length ? ", " : ""}${JSON.stringify(field)}: ${encoded}`,
        },
      ];
    }
    const first = scope.scope.items[0]?.key as Node | undefined;
    const position = scope.offset + (first?.range?.[0] ?? scope.scope.range[0]);
    const start =
      Math.max(
        source.source.lastIndexOf("\n", position - 1),
        source.source.lastIndexOf("\r", position - 1),
      ) + 1;
    const indent = source.source.slice(start, position);
    return [
      {
        range: { start, end: start },
        value: `${indent}${field}: ${encoded}${source.newline}`,
      },
    ];
  }
  const header = source.statements.find((record) => record.kind === "header");
  if (!header) return null;
  return [
    {
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify({ gantt: { [field]: value } })}}%%${source.newline}`,
    },
  ];
}
