// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceYaml,
  type SourceValuePatch,
} from "../source-yaml.js";
import type { ErSourceDocument, ErSourceRecord } from "./source-document.js";
import type { ErDirection } from "./model.js";
export const ER_CONFIG_FIELDS = [
  "titleTopMargin",
  "diagramPadding",
  "layoutDirection",
  "minEntityWidth",
  "minEntityHeight",
  "entityPadding",
  "nodeSpacing",
  "rankSpacing",
  "stroke",
  "fill",
  "fontSize",
  "useMaxWidth",
] as const;
export type ErConfigField = (typeof ER_CONFIG_FIELDS)[number];
export type ErConfig = {
  titleTopMargin: number;
  diagramPadding: number;
  layoutDirection: ErDirection;
  minEntityWidth: number;
  minEntityHeight: number;
  entityPadding: number;
  nodeSpacing: number;
  rankSpacing: number;
  stroke: string;
  fill: string;
  fontSize: number;
  useMaxWidth: boolean;
};
// Geometry and typography defaults match the pinned ER runtime. Unauthored
// colors use the server theme rather than Mermaid's built-in palette.
export const ER_DEFAULT_CONFIG: ErConfig = {
  titleTopMargin: 25,
  diagramPadding: 20,
  layoutDirection: "TB",
  minEntityWidth: 100,
  minEntityHeight: 75,
  entityPadding: 15,
  nodeSpacing: 140,
  rankSpacing: 80,
  stroke: "",
  fill: "",
  fontSize: 12,
  useMaxWidth: true,
};
export function isErConfigValue(field: ErConfigField, value: unknown) {
  if (field === "layoutDirection")
    return (
      typeof value === "string" && ["TB", "BT", "LR", "RL"].includes(value)
    );
  if (field === "useMaxWidth") return typeof value === "boolean";
  if (field === "stroke" || field === "fill")
    return typeof value === "string" && !/[\r\n]/.test(value);
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= (field === "fontSize" ? 1 : 0)
  );
}
export function readErConfig(document: ErSourceDocument) {
  const scopes: Array<{
    record: ErSourceRecord;
    yaml: SourceYaml;
    path: string[];
  }> = [];
  const effective: Record<string, unknown> = { ...ER_DEFAULT_CONFIG };
  for (const record of document.records
    .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
    .sort(
      (a, b) =>
        Number(b.kind === "frontmatter") - Number(a.kind === "frontmatter"),
    )) {
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
    if (!yaml) continue;
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : "init" in yaml.values
          ? "init"
          : "initialize";
    const root = yaml.values[prefix];
    if (!root || typeof root !== "object" || Array.isArray(root)) continue;
    const values = root as Record<string, unknown>,
      path = [prefix];
    if (
      record.kind === "directive" &&
      values.config &&
      typeof values.config === "object" &&
      !Array.isArray(values.config)
    )
      path.push("config");
    scopes.push({ record, yaml, path });
    const config =
      path.length > 1 ? (values.config as Record<string, unknown>) : values;
    const group = config.er;
    if (group && typeof group === "object" && !Array.isArray(group))
      for (const field of ER_CONFIG_FIELDS)
        if (Object.hasOwn(group, field))
          effective[field] = (group as Record<string, unknown>)[field];
  }
  const config: ErConfig = { ...ER_DEFAULT_CONFIG },
    invalid: ErConfigField[] = [];
  for (const field of ER_CONFIG_FIELDS)
    if (isErConfigValue(field, effective[field]))
      Object.assign(config, { [field]: effective[field] });
    else invalid.push(field);
  return { config, effective, scopes, invalid };
}
export function erConfigPatches(
  document: ErSourceDocument,
  changes: Partial<ErConfig>,
) {
  const { scopes, effective } = readErConfig(document);
  const patches: SourceValuePatch[] = [],
    missing: Record<string, unknown> = {};
  for (const field of ER_CONFIG_FIELDS) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(changes[field], effective[field])
    )
      continue;
    if (!isErConfigValue(field, changes[field])) return null;
    const owner = scopes.findLast((scope) => {
      let v: unknown = scope.yaml.values;
      for (const k of [...scope.path, "er"])
        v =
          v && typeof v === "object"
            ? (v as Record<string, unknown>)[k]
            : undefined;
      return v && typeof v === "object" && Object.hasOwn(v, field);
    });
    if (owner) {
      const result = sourceYamlFieldPatch(
        owner.yaml,
        [...owner.path, "er", field],
        changes[field],
      );
      if (!result) return null;
      patches.push(...result);
    } else missing[field] = changes[field];
  }
  if (Object.keys(missing).length) {
    const header = document.records.find((r) => r.kind === "header");
    if (!header) return null;
    patches.push({
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify({ er: missing })}}%%${document.newline}`,
    });
  }
  return patches;
}
