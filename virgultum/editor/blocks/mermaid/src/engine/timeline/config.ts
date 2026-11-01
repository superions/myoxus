// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  type Node,
  type YAMLMap,
} from "yaml";
import type {
  TimelineSourceDocument,
  TimelineSourceStatement,
} from "./source-document.js";
import type { TimelinePatch } from "./writer.js";
import type { TimelineDiagnostic } from "./diagnostics.js";

// Proven against TimelineDiagramConfig and both bound 11.17.2 renderers.
export const TIMELINE_CONFIG_FIELDS = {
  useMaxWidth: "boolean",
  leftMargin: "number",
  padding: "number",
  disableMulticolor: "boolean",
  useWidth: "number",
  diagramMarginX: "number",
  diagramMarginY: "number",
  width: "number",
  height: "number",
  boxMargin: "number",
  boxTextMargin: "number",
  noteMargin: "number",
  messageMargin: "number",
  messageAlign: "alignment",
  bottomMarginAdj: "number",
  rightAngles: "boolean",
  taskFontSize: "size",
  taskFontFamily: "string",
  taskMargin: "number",
  activationWidth: "number",
  textPlacement: "string",
  actorColours: "strings",
  sectionFills: "strings",
  sectionColours: "strings",
} as const;
export type TimelineConfigField = keyof typeof TIMELINE_CONFIG_FIELDS;
export type TimelineConfigValue = string | number | boolean | readonly string[];
export const TIMELINE_EFFECTIVE_CONFIG_FIELDS = [
  "useMaxWidth",
  "leftMargin",
  "padding",
  "disableMulticolor",
] as const;
export const TIMELINE_CONFIG_DEFAULTS = {
  useMaxWidth: true,
  leftMargin: 150,
  padding: 50,
  disableMulticolor: false,
} as const;
export type TimelineConfigOccurrence = {
  readonly field: string;
  readonly value: unknown;
  readonly record: TimelineSourceStatement;
  readonly scope: YAMLMap;
  readonly keyNode: Node;
  readonly valueNode: Node;
  readonly offset: number;
  readonly rendered: boolean;
  readonly effective: boolean;
  readonly alias?: TimelineConfigAliasScope;
};
type TimelineConfigAliasScope = {
  readonly node: Node;
  readonly value: Record<string, unknown>;
  readonly prefix: boolean;
};
export type TimelineConfigProjection = {
  readonly occurrences: readonly TimelineConfigOccurrence[];
  readonly effective: Readonly<Record<string, unknown>>;
  readonly scopes: readonly {
    readonly scope: YAMLMap;
    readonly offset: number;
    readonly alias?: TimelineConfigAliasScope;
  }[];
  readonly diagnostics: readonly TimelineDiagnostic[];
  readonly frontmatterTitle?: {
    readonly value: string;
    readonly record: TimelineSourceStatement;
    readonly range: { start: number; end: number; line: number };
  };
};

export function isSupportedTimelineHeader(value: string) {
  return /^timeline(?:[ \t]+(?:LR|TD))?$/i.test(value);
}
export function isTimelineConfigField(
  field: string,
): field is TimelineConfigField {
  return Object.hasOwn(TIMELINE_CONFIG_FIELDS, field);
}
export function validTimelineConfigValue(
  field: TimelineConfigField,
  value: TimelineConfigValue,
) {
  const type = TIMELINE_CONFIG_FIELDS[field];
  if (type === "number")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (!(field === "leftMargin" || field === "padding") || value >= 0)
    );
  if (type === "boolean") return typeof value === "boolean";
  if (type === "strings")
    return (
      Array.isArray(value) && value.every((item) => typeof item === "string")
    );
  if (type === "alignment")
    return value === "left" || value === "center" || value === "right";
  if (type === "size")
    return (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value) && value >= 0)
    );
  return typeof value === "string" && !/[\r\n]/.test(value);
}

/** CST anchors keep unknown config, quoting, comments and lower overrides intact. */
export function readTimelineConfig(
  source: TimelineSourceDocument,
): TimelineConfigProjection {
  const occurrences: TimelineConfigOccurrence[] = [];
  const scopes: {
    scope: YAMLMap;
    offset: number;
    alias?: TimelineConfigAliasScope;
  }[] = [];
  const diagnostics: TimelineDiagnostic[] = [];
  let frontmatterTitle: TimelineConfigProjection["frontmatterTitle"];
  for (const record of source.statements) {
    if (record.kind !== "frontmatter" && record.kind !== "directive") continue;
    if (!record.complete) {
      diagnostics.push({
        code: "config",
        range: record.range,
        anchorId: record.id,
      });
      continue;
    }
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
    let values: Record<string, unknown>;
    try {
      if (document.errors.length) throw new Error("config");
      if (!isMap(document.contents)) throw new Error("config");
      values = document.toJS({ maxAliasCount: 100 }) ?? {};
    } catch {
      diagnostics.push({
        code: "config",
        range: record.range,
        anchorId: record.id,
      });
      continue;
    }
    const offset = record.range.start + start;
    if (record.kind === "frontmatter") {
      const title = document.get("title", true);
      if (
        (isScalar(title) || isAlias(title)) &&
        title.range &&
        typeof values.title === "string"
      )
        frontmatterTitle = {
          value: values.title,
          record,
          range: {
            start: offset + title.range[0],
            end: offset + title.range[1],
            line: record.range.line + 1,
          },
        };
    }
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : document.has("init")
          ? "init"
          : "initialize";
    const prefixNode = document.get(prefix, true);
    const prefixMap = isAlias(prefixNode)
      ? prefixNode.resolve(document)
      : prefixNode;
    const timelineNode = isMap(prefixMap)
      ? prefixMap.get("timeline", true)
      : undefined;
    const scope = isAlias(timelineNode)
      ? timelineNode.resolve(document)
      : timelineNode;
    if (!isMap(scope)) continue;
    const config = values[prefix] as Record<string, unknown> | undefined;
    const resolved = (config?.timeline ?? {}) as Record<string, unknown>;
    const alias: TimelineConfigAliasScope | undefined = isAlias(prefixNode)
      ? { node: prefixNode, value: config!, prefix: true }
      : isAlias(timelineNode)
        ? { node: timelineNode, value: resolved, prefix: false }
        : undefined;
    scopes.push({ scope, offset, alias });
    for (const pair of scope.items) {
      if (!isScalar(pair.key) || !pair.key.range || !pair.value) continue;
      const valueNode = pair.value as Node;
      if (!valueNode.range) continue;
      const field = String(pair.key.value);
      occurrences.push({
        field,
        value: resolved[field],
        record,
        scope,
        keyNode: pair.key,
        valueNode,
        offset,
        rendered: (
          TIMELINE_EFFECTIVE_CONFIG_FIELDS as readonly string[]
        ).includes(field),
        effective: false,
        alias,
      });
    }
  }
  const last = new Map(occurrences.map((item, index) => [item.field, index]));
  return {
    occurrences: occurrences.map((item, index) => ({
      ...item,
      effective: last.get(item.field) === index,
    })),
    scopes,
    diagnostics,
    frontmatterTitle,
    effective: {
      ...TIMELINE_CONFIG_DEFAULTS,
      ...Object.fromEntries(
        occurrences.map((item) => [item.field, item.value]),
      ),
    },
  };
}

/** A map alias cannot be edited at its definition: that would change other consumers.
 * Materialize only this reference, retaining unknown resolved properties and the anchor. */
function aliasScopePatch(
  alias: TimelineConfigAliasScope,
  offset: number,
  field: string,
  value: TimelineConfigValue | undefined,
): readonly TimelinePatch[] | null {
  if (!alias.node.range) return null;
  const timeline = {
    ...(alias.prefix
      ? (alias.value.timeline as Record<string, unknown>)
      : alias.value),
  };
  if (value === undefined) delete timeline[field];
  else timeline[field] = value;
  try {
    return [
      {
        range: {
          start: offset + alias.node.range[0],
          end: offset + alias.node.range[1],
        },
        value: JSON.stringify(
          alias.prefix ? { ...alias.value, timeline } : timeline,
        ),
      },
    ];
  } catch {
    return null;
  }
}

/** Patch the selected occurrence (or effective property), without regenerating config. */
export function timelineConfigPatches(
  source: TimelineSourceDocument,
  field: TimelineConfigField,
  value: TimelineConfigValue | undefined,
  occurrence?: { readonly statementId: string },
): readonly TimelinePatch[] | null {
  const { occurrences, scopes } = readTimelineConfig(source);
  const existing = occurrence
    ? occurrences.find(
        (item) =>
          item.field === field && item.record.id === occurrence.statementId,
      )
    : occurrences.findLast((item) => item.field === field);
  if (occurrence && !existing) return null;
  if (existing) {
    if (
      value !== undefined &&
      (Object.is(existing.value, value) ||
        (Array.isArray(existing.value) &&
          Array.isArray(value) &&
          existing.value.length === value.length &&
          existing.value.every((item, index) => item === value[index])))
    )
      return [];
    if (existing.alias)
      return aliasScopePatch(existing.alias, existing.offset, field, value);
    if (value !== undefined)
      return [
        {
          range: {
            start: existing.offset + existing.valueNode.range![0],
            end: existing.offset + existing.valueNode.range![1],
          },
          value: JSON.stringify(value),
        },
      ];
    const index = existing.scope.items.findIndex(
      (pair) => pair.key === existing.keyNode,
    );
    const start = existing.keyNode.range![0];
    const end = existing.valueNode.range![1];
    const patches: TimelinePatch[] = [
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
  if (scope?.alias)
    return aliasScopePatch(scope.alias, scope.offset, field, value);
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
  const lastDirective = source.statements.findLast(
    (record) => record.kind === "directive" && record.complete,
  );
  const position = lastDirective
    ? lastDirective.range.end + lastDirective.eol.length
    : header.range.start;
  return [
    {
      range: { start: position, end: position },
      value: `${lastDirective && !lastDirective.eol ? source.newline : ""}%%{init: ${JSON.stringify({ timeline: { [field]: value } })}}%%${source.newline}`,
    },
  ];
}
