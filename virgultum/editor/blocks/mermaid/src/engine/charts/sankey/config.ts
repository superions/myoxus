// SPDX-License-Identifier: AGPL-3.0-or-later

import { isMap, isScalar, parseDocument, type Node, type YAMLMap } from "yaml";
import type { SankeyDiagnostic } from "./diagnostics.js";
import type { SankeySourceDocument, SankeyRecord } from "./source-document.js";

export type SankeyConfig = {
  useMaxWidth: boolean;
  width: number;
  height: number;
  linkColor: string;
  nodeAlignment: "left" | "right" | "center" | "justify";
  showValues: boolean;
  prefix: string;
  suffix: string;
  nodeWidth: number;
  nodePadding: number;
  labelStyle: "legacy" | "outlined";
  nodeColors: Record<string, string>;
};

export const SANKEY_DEFAULT_CONFIG: Readonly<SankeyConfig> = {
  useMaxWidth: true,
  width: 600,
  height: 400,
  linkColor: "gradient",
  nodeAlignment: "justify",
  showValues: true,
  prefix: "",
  suffix: "",
  nodeWidth: 10,
  nodePadding: 12,
  labelStyle: "legacy",
  nodeColors: {},
};

export function validSankeyConfigField(
  field: keyof SankeyConfig,
  value: unknown,
) {
  if (field === "useMaxWidth" || field === "showValues")
    return typeof value === "boolean";
  if (field === "prefix" || field === "suffix")
    return typeof value === "string";
  if (field === "nodeAlignment")
    return ["left", "right", "center", "justify"].includes(String(value));
  if (field === "labelStyle") return value === "legacy" || value === "outlined";
  if (field === "linkColor")
    return (
      typeof value === "string" &&
      (["source", "target", "gradient"].includes(value) ||
        CSS.supports("color", value))
    );
  if (field === "nodeColors")
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(
        (color) => typeof color === "string" && CSS.supports("color", color),
      )
    );
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (field === "nodePadding" ? value >= 0 : value > 0)
  );
}

/** YAML CST ranges also cover JSON init directives without regex field guessing. */
export function sankeyConfigDocument(record: SankeyRecord) {
  if (record.kind !== "frontmatter" && record.kind !== "directive") return null;
  const start =
    record.kind === "frontmatter"
      ? record.raw.indexOf("\n") + 1
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
  const prefix =
    record.kind === "frontmatter"
      ? "config"
      : document.has("init")
        ? "init"
        : "initialize";
  const scope = document.getIn([prefix, "sankey"], true);
  return {
    document,
    offset: record.range.start + start,
    path: [prefix, "sankey"],
    scope: isMap(scope) ? scope : null,
  };
}

export type SankeyConfigOccurrence = {
  readonly field: keyof SankeyConfig;
  readonly record: SankeyRecord;
  readonly scope: YAMLMap;
  readonly key: Node;
  readonly value: Node;
  readonly resolvedValue: unknown;
  readonly offset: number;
};

export function readSankeyConfig(source: SankeySourceDocument) {
  const effective: SankeyConfig = { ...SANKEY_DEFAULT_CONFIG, nodeColors: {} };
  const diagnostics: SankeyDiagnostic[] = [];
  const occurrences: SankeyConfigOccurrence[] = [];
  const scopes: { record: SankeyRecord; scope: YAMLMap; offset: number }[] = [];
  let title = "";
  for (const record of source.records) {
    const parsed = sankeyConfigDocument(record);
    if (!parsed) continue;
    if (parsed.document.errors.length) {
      diagnostics.push({
        code: "config",
        recordId: record.id,
        line: record.range.line,
        impact: "record",
      });
      continue;
    }
    if (record.kind === "frontmatter") {
      const value = parsed.document.get("title");
      if (value !== undefined && value !== null) title = String(value);
    }
    if (!parsed.scope) continue;
    let resolved: unknown;
    try {
      resolved = parsed.document.toJS({ maxAliasCount: 100 });
      for (const key of parsed.path) {
        resolved =
          resolved !== null &&
          typeof resolved === "object" &&
          Object.hasOwn(resolved, key)
            ? (resolved as Record<string, unknown>)[key]
            : undefined;
      }
    } catch {
      // Invalid/cyclic aliases belong to this config record, not a renderer
      // exception that destroys the otherwise repairable CSV projection.
      diagnostics.push({
        code: "config",
        recordId: record.id,
        line: record.range.line,
        impact: "record",
      });
      continue;
    }
    scopes.push({ record, scope: parsed.scope, offset: parsed.offset });
    for (const pair of parsed.scope.items) {
      if (
        !isScalar(pair.key) ||
        !Object.hasOwn(SANKEY_DEFAULT_CONFIG, String(pair.key.value))
      )
        continue;
      const field = String(pair.key.value) as keyof SankeyConfig;
      const node = parsed.scope.get(field, true) as Node | undefined;
      if (!node?.range) continue;
      const value =
        resolved !== null && typeof resolved === "object"
          ? (resolved as Record<string, unknown>)[field]
          : undefined;
      occurrences.push({
        field,
        record,
        scope: parsed.scope,
        key: pair.key,
        value: node,
        resolvedValue: value,
        offset: parsed.offset,
      });
      if (validSankeyConfigField(field, value))
        Object.assign(effective, { [field]: value });
      else
        diagnostics.push({
          code: "config",
          recordId: record.id,
          line:
            record.range.line +
            (source.source
              .slice(record.range.start, parsed.offset + node.range[0])
              .match(/\r\n|\r|\n/g)?.length ?? 0),
          configField: field,
          effectiveValue: String(value),
          impact: "record",
        });
    }
  }
  return { effective, diagnostics, occurrences, scopes, title };
}
