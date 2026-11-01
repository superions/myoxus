// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceYaml,
  type SourceValuePatch,
} from "../source-yaml.js";
import type {
  SequenceSourceDocument,
  SequenceSourceRecord,
} from "./source-document.js";
export type SequenceConfig = {
  arrowMarkerAbsolute: boolean;
  hideUnusedParticipants: boolean;
  activationWidth: number;
  diagramMarginX: number;
  diagramMarginY: number;
  actorMargin: number;
  width: number;
  height: number;
  boxMargin: number;
  boxTextMargin: number;
  noteMargin: number;
  messageMargin: number;
  messageAlign: "left" | "center" | "right";
  mirrorActors: boolean;
  bottomMarginAdj: number;
  rightAngles: boolean;
  showSequenceNumbers: boolean;
  wrap: boolean;
  wrapPadding: number;
  labelBoxWidth: number;
  labelBoxHeight: number;
  actorFontSize: string | number;
  actorFontFamily: string;
  actorFontWeight: string | number;
  noteFontSize: string | number;
  noteFontFamily: string;
  noteFontWeight: string | number;
  noteAlign: "left" | "center" | "right";
  messageFontSize: string | number;
  messageFontFamily: string;
  messageFontWeight: string | number;
  useMaxWidth: boolean;
};
// Geometry follows Mermaid 11.17.2. Unauthored font families use the actual
// editor theme; no upstream font or color fallback is projected into GFX.
export const SEQUENCE_DEFAULT_CONFIG: SequenceConfig = {
  arrowMarkerAbsolute: false,
  useMaxWidth: true,
  hideUnusedParticipants: false,
  activationWidth: 10,
  diagramMarginX: 50,
  diagramMarginY: 10,
  actorMargin: 50,
  width: 150,
  height: 65,
  boxMargin: 10,
  boxTextMargin: 5,
  noteMargin: 10,
  messageMargin: 35,
  messageAlign: "center",
  mirrorActors: true,
  bottomMarginAdj: 1,
  rightAngles: false,
  showSequenceNumbers: false,
  actorFontSize: 14,
  actorFontFamily: "",
  actorFontWeight: 400,
  noteFontSize: 14,
  noteFontFamily: "",
  noteFontWeight: 400,
  noteAlign: "center",
  messageFontSize: 16,
  messageFontFamily: "",
  messageFontWeight: 400,
  wrap: false,
  wrapPadding: 10,
  labelBoxWidth: 50,
  labelBoxHeight: 20,
};
export type SequenceConfigField = keyof SequenceConfig;
export const SEQUENCE_CONFIG_FIELDS = Object.keys(
  SEQUENCE_DEFAULT_CONFIG,
) as SequenceConfigField[];
export function isSequenceConfigValue(
  field: SequenceConfigField,
  value: unknown,
) {
  if (field.endsWith("Align"))
    return (
      typeof value === "string" && ["left", "center", "right"].includes(value)
    );
  if (typeof SEQUENCE_DEFAULT_CONFIG[field] === "boolean")
    return typeof value === "boolean";
  if (field.endsWith("Family"))
    return typeof value === "string" && !/[\r\n]/.test(value);
  if (field.endsWith("Weight"))
    return (
      (typeof value === "number" && Number.isFinite(value) && value > 0) ||
      (typeof value === "string" &&
        /^(?:normal|bold|[1-9]\d{0,3})$/.test(value))
    );
  if (field.endsWith("FontSize") && typeof value === "string")
    return (
      /^(?:\d+(?:\.\d+)?)(?:px|pt|em|rem|%)?$/.test(value) &&
      parseFloat(value) > 0
    );
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >=
      (field.endsWith("FontSize") ? 1 : field === "bottomMarginAdj" ? -1000 : 0)
  );
}
export function readSequenceConfig(document: SequenceSourceDocument) {
  const scopes: Array<{
    record: SequenceSourceRecord;
    yaml: SourceYaml;
    path: string[];
  }> = [];
  const effective: Record<string, unknown> = { ...SEQUENCE_DEFAULT_CONFIG };
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
    const group = config.sequence;
    if (group && typeof group === "object" && !Array.isArray(group))
      for (const field of SEQUENCE_CONFIG_FIELDS)
        if (Object.hasOwn(group, field))
          effective[field] = (group as Record<string, unknown>)[field];
  }
  const config: SequenceConfig = { ...SEQUENCE_DEFAULT_CONFIG },
    invalid: SequenceConfigField[] = [];
  for (const field of SEQUENCE_CONFIG_FIELDS)
    if (isSequenceConfigValue(field, effective[field]))
      Object.assign(config, { [field]: effective[field] });
    else invalid.push(field);
  return { config, effective, scopes, invalid };
}
export function sequenceConfigPatches(
  document: SequenceSourceDocument,
  changes: Partial<SequenceConfig>,
) {
  const { scopes, effective } = readSequenceConfig(document);
  const patches: SourceValuePatch[] = [],
    missing: Record<string, unknown> = {};
  for (const field of SEQUENCE_CONFIG_FIELDS) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(changes[field], effective[field])
    )
      continue;
    if (!isSequenceConfigValue(field, changes[field])) return null;
    const owner = scopes.findLast((scope) => {
      let v: unknown = scope.yaml.values;
      for (const k of [...scope.path, "sequence"])
        v =
          v && typeof v === "object"
            ? (v as Record<string, unknown>)[k]
            : undefined;
      return v && typeof v === "object" && Object.hasOwn(v, field);
    });
    if (owner) {
      const result = sourceYamlFieldPatch(
        owner.yaml,
        [...owner.path, "sequence", field],
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
      value: `%%{init: ${JSON.stringify({ sequence: missing })}}%%${document.newline}`,
    });
  }
  return patches;
}

export const SEQUENCE_CONFIG_CONSUMERS = Object.fromEntries(
  SEQUENCE_CONFIG_FIELDS.map((field) => [
    field,
    field === "arrowMarkerAbsolute" || field === "useMaxWidth" ? "svg" : "gfx",
  ]),
) as Record<SequenceConfigField, "svg" | "gfx">;
