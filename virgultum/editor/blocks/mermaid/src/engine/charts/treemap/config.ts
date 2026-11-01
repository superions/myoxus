// SPDX-License-Identifier: AGPL-3.0-or-later

import { isMap, isScalar, parseDocument, type Node, type YAMLMap } from "yaml";
import type { TreemapDiagnostic } from "./diagnostics.js";
import { TREEMAP_DEFAULT_CONFIG, type TreemapConfig } from "./model.js";
import type {
  TreemapSourceDocument,
  TreemapSourceRecord,
} from "./source-document.js";

export function validTreemapConfigField(
  field: keyof TreemapConfig,
  value: unknown,
) {
  if (field === "useMaxWidth" || field === "showValues")
    return typeof value === "boolean";
  if (field === "valueFormat")
    return (
      typeof value === "string" &&
      (value === "$0,0" ||
        /^(?:(.)?([<>=^]))?([+\-( ])?([$#])?(0)?(\d+)?(,)?(\.\d+)?(~)?([a-zA-Z%])?$/.test(
          value,
        ))
    );
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (field === "padding" ||
    field === "diagramPadding" ||
    field === "borderWidth"
      ? value >= 0
      : value > 0)
  );
}

export function treemapConfigDocument(record: TreemapSourceRecord) {
  if (record.kind !== "frontmatter" && record.kind !== "directive") return null;
  const start =
    record.kind === "frontmatter"
      ? record.raw.search(/\r?\n/) + (record.raw.includes("\r\n") ? 2 : 1)
      : record.raw.indexOf("%%{") + 2;
  const end =
    record.kind === "frontmatter"
      ? record.raw.lastIndexOf("---")
      : record.raw.lastIndexOf("}%%") + 1;
  if (start <= 0 || end < start) return null;
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
  const scope = document.getIn([prefix, "treemap"], true);
  return {
    document,
    offset: record.range.start + start,
    path: [prefix, "treemap"] as const,
    scope: isMap(scope) ? scope : null,
  };
}

export type TreemapConfigOccurrence = {
  readonly field: keyof TreemapConfig;
  readonly record: TreemapSourceRecord;
  readonly scope: YAMLMap;
  readonly key: Node;
  readonly value: Node;
  readonly resolvedValue: unknown;
  readonly offset: number;
};

export function readTreemapConfig(source: TreemapSourceDocument) {
  const effective: TreemapConfig = { ...TREEMAP_DEFAULT_CONFIG };
  const diagnostics: TreemapDiagnostic[] = [];
  const occurrences: TreemapConfigOccurrence[] = [];
  let frontmatterTitle = "";
  for (const record of source.records) {
    const parsed = treemapConfigDocument(record);
    if (!parsed) continue;
    if (parsed.document.errors.length) {
      diagnostics.push({
        code: "invalid-config",
        recordId: record.id,
        range: record.range,
        impact: "record",
      });
      continue;
    }
    if (record.kind === "frontmatter") {
      const title = parsed.document.get("title");
      if (title !== undefined && title !== null)
        frontmatterTitle = String(title);
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
      diagnostics.push({
        code: "invalid-config",
        recordId: record.id,
        range: record.range,
        impact: "record",
      });
      continue;
    }
    for (const pair of parsed.scope.items) {
      if (
        !isScalar(pair.key) ||
        !Object.hasOwn(TREEMAP_DEFAULT_CONFIG, String(pair.key.value))
      )
        continue;
      const field = String(pair.key.value) as keyof TreemapConfig;
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
      if (validTreemapConfigField(field, value))
        Object.assign(effective, { [field]: value });
      else
        diagnostics.push({
          code: "invalid-config",
          recordId: record.id,
          range: record.range,
          impact: "record",
        });
    }
  }
  return { effective, diagnostics, occurrences, frontmatterTitle };
}
