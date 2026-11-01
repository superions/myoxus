// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceYaml,
} from "../source-yaml.js";
import type {
  ClassSourceDocument,
  ClassSourceRecord,
} from "./source-document.js";

export const CLASS_CONFIG_FIELDS = [
  "padding",
  "hideEmptyMembersBox",
  "hierarchicalNamespaces",
  "nodeSpacing",
  "rankSpacing",
  "defaultRenderer",
  "htmlLabels",
  "useMaxWidth",
] as const;
export type ClassConfigField = (typeof CLASS_CONFIG_FIELDS)[number];
export type ClassConfig = {
  padding: number;
  hideEmptyMembersBox: boolean;
  hierarchicalNamespaces: boolean;
  nodeSpacing: number;
  rankSpacing: number;
  defaultRenderer: string;
  htmlLabels: boolean;
  useMaxWidth: boolean;
};
export const CLASS_DEFAULT_CONFIG: ClassConfig = {
  padding: 5,
  hideEmptyMembersBox: false,
  hierarchicalNamespaces: true,
  nodeSpacing: 50,
  rankSpacing: 50,
  defaultRenderer: "dagre-wrapper",
  htmlLabels: true,
  useMaxWidth: true,
};
function classConfigContainer(field: ClassConfigField) {
  return ["nodeSpacing", "rankSpacing", "useMaxWidth"].includes(field)
    ? "state"
    : field === "htmlLabels"
      ? ""
      : "class";
}
export type ClassConfigScope = {
  record: ClassSourceRecord;
  yaml: SourceYaml;
  path: string[];
};
/** 11.17.2 classBox/ClassDB consume these three class options. The unified
 * renderer reads title/spacing/useMaxWidth from state, fixes diagram padding at
 * eight, and reads global htmlLabels. Retain other class options as Source data;
 * the type schema alone does not justify visual controls for ignored leaves. */
export function readClassConfig(document: ClassSourceDocument) {
  const effective: Record<string, unknown> = { ...CLASS_DEFAULT_CONFIG };
  const scopes: ClassConfigScope[] = [];

  const records = document.records
    .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
    .sort(
      (a, b) =>
        Number(b.kind === "frontmatter") - Number(a.kind === "frontmatter"),
    );
  for (const record of records) {
    if (
      record.kind === "directive" &&
      !/^%%\{\s*(init|initialize)\s*:/i.test(record.raw.trim())
    )
      continue;
    const start =
      record.kind === "frontmatter"
        ? record.raw.indexOf("\n") + 1
        : record.raw.indexOf("%%{") + 2;
    const end =
      record.kind === "frontmatter"
        ? record.raw.lastIndexOf("---")
        : record.raw.lastIndexOf("}%%") + 1;
    const yaml = readSourceYaml(
      record.raw.slice(start, end),
      record.range.start + start,
    );
    if (!yaml) continue; // Opaque config does not invalidate independent Class records.
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : "init" in yaml.values
          ? "init"
          : "initialize";
    const root = yaml.values[prefix];
    if (!root || typeof root !== "object" || Array.isArray(root)) continue;
    const values = root as Record<string, unknown>;
    const path = [prefix];
    if (
      record.kind === "directive" &&
      values.config &&
      typeof values.config === "object" &&
      !Array.isArray(values.config)
    )
      path.push("config");
    scopes.push({ record, yaml, path });
    const rootValues =
      path.length > 1 ? (values.config as Record<string, unknown>) : values;
    for (const field of CLASS_CONFIG_FIELDS) {
      const container = classConfigContainer(field);
      const group = container ? rootValues[container] : rootValues;
      if (
        group &&
        typeof group === "object" &&
        !Array.isArray(group) &&
        Object.hasOwn(group, field)
      )
        effective[field] = (group as Record<string, unknown>)[field];
    }
  }
  const config: ClassConfig = { ...CLASS_DEFAULT_CONFIG };
  const invalid: ClassConfigField[] = [];
  for (const field of CLASS_CONFIG_FIELDS) {
    const value = effective[field];
    if (isClassConfigValue(field, value))
      Object.assign(config, { [field]: value });
    else invalid.push(field);
  }
  return {
    effective,
    scopes,
    config,
    invalid,
    htmlLabels: config.htmlLabels,
    renderer: config.defaultRenderer,
  };
}
export function isClassConfigValue(field: ClassConfigField, value: unknown) {
  if (["padding", "nodeSpacing", "rankSpacing"].includes(field))
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (field === "defaultRenderer")
    return (
      typeof value === "string" &&
      Boolean(value.trim()) &&
      !/[\r\n]/.test(value)
    );
  return typeof value === "boolean";
}
export function classConfigPatches(
  document: ClassSourceDocument,
  changes: Partial<ClassConfig>,
) {
  const { scopes, effective } = readClassConfig(document);
  const patches: import("../source-yaml.js").SourceValuePatch[] = [];
  const missing: Record<string, unknown> = {};
  for (const field of CLASS_CONFIG_FIELDS) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(changes[field], effective[field])
    )
      continue;
    if (!isClassConfigValue(field, changes[field])) return null;
    const container = classConfigContainer(field);
    const owner = scopes.findLast((scope) => {
      let value: unknown = scope.yaml.values;
      for (const step of [...scope.path, ...(container ? [container] : [])])
        value =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[step]
            : undefined;
      return value && typeof value === "object" && Object.hasOwn(value, field);
    });
    if (owner) {
      const result = sourceYamlFieldPatch(
        owner.yaml,
        [...owner.path, ...(container ? [container] : []), field],
        changes[field],
      );
      if (!result) return null;
      patches.push(...result);
    } else if (container) {
      const value = (missing[container] ??= {}) as Record<string, unknown>;
      value[field] = changes[field];
    } else missing[field] = changes[field];
  }
  if (Object.keys(missing).length) {
    const header = document.records.find((r) => r.kind === "header");
    if (!header) return null;
    patches.push({
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify(missing)}}%%${document.newline}`,
    });
  }
  return patches;
}
