// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceYaml,
  type SourceValuePatch,
} from "../source-yaml.js";

export type StateConfig = {
  titleTopMargin: number;
  arrowMarkerAbsolute: boolean;
  dividerMargin: number;
  sizeUnit: number;
  padding: number;
  textHeight: number;
  titleShift: number;
  noteMargin: number;
  nodeSpacing: number;
  rankSpacing: number;
  forkWidth: number;
  forkHeight: number;
  miniPadding: number;
  fontSizeFactor: number;
  fontSize: number;
  labelHeight: number;
  edgeLengthFactor: string;
  compositTitleSize: number;
  radius: number;
  defaultRenderer: "dagre-d3" | "dagre-wrapper" | "elk";
  useMaxWidth: boolean;
};

/** State defaults are the pinned 11.17.2 schema. The unified renderer supplies
 * the two spacing defaults itself; SVG options never select another editor. */
export const STATE_DEFAULT_CONFIG: StateConfig = {
  titleTopMargin: 25,
  arrowMarkerAbsolute: false,
  dividerMargin: 10,
  sizeUnit: 5,
  padding: 8,
  textHeight: 10,
  titleShift: -15,
  noteMargin: 10,
  nodeSpacing: 50,
  rankSpacing: 50,
  forkWidth: 70,
  forkHeight: 7,
  miniPadding: 2,
  fontSizeFactor: 5.02,
  fontSize: 24,
  labelHeight: 16,
  edgeLengthFactor: "20",
  compositTitleSize: 35,
  radius: 5,
  defaultRenderer: "dagre-wrapper",
  useMaxWidth: true,
};
export type StateConfigField = keyof StateConfig;
export const STATE_CONFIG_FIELDS = Object.keys(
  STATE_DEFAULT_CONFIG,
) as StateConfigField[];
export function isStateConfigValue(field: StateConfigField, value: unknown) {
  if (field === "defaultRenderer")
    return ["dagre-d3", "dagre-wrapper", "elk"].includes(String(value));
  if (field === "edgeLengthFactor")
    return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
  if (typeof STATE_DEFAULT_CONFIG[field] === "boolean")
    return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (field === "titleShift" || value >= (field === "fontSize" ? 1 : 0))
  );
}
type ConfigRecord = {
  kind: string;
  raw: string;
  range: { start: number; end: number };
};
type ConfigDocument = { records: readonly ConfigRecord[]; newline: string };
export function readStateConfig(document: ConfigDocument) {
  const effective: Record<string, unknown> = { ...STATE_DEFAULT_CONFIG };
  const scopes: Array<{
    record: ConfigRecord;
    yaml: SourceYaml;
    path: string[];
  }> = [];
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
    const path = [prefix];
    const values = root as Record<string, unknown>;
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
    const state = config.state;
    if (state && typeof state === "object" && !Array.isArray(state))
      for (const field of STATE_CONFIG_FIELDS)
        if (Object.hasOwn(state, field))
          effective[field] = (state as Record<string, unknown>)[field];
    // Both native State initializers take this option from the global config.
    if (Object.hasOwn(config, "arrowMarkerAbsolute"))
      effective.arrowMarkerAbsolute = config.arrowMarkerAbsolute;
  }
  const config = { ...STATE_DEFAULT_CONFIG },
    invalid: StateConfigField[] = [];
  for (const field of STATE_CONFIG_FIELDS)
    if (isStateConfigValue(field, effective[field]))
      Object.assign(config, { [field]: effective[field] });
    else invalid.push(field);
  return { config, effective, scopes, invalid };
}
export function stateConfigPatches(
  document: ConfigDocument,
  changes: Partial<StateConfig>,
) {
  const { scopes, effective } = readStateConfig(document);
  const patches: SourceValuePatch[] = [],
    missing: Record<string, unknown> = {};
  for (const field of STATE_CONFIG_FIELDS) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(effective[field], changes[field])
    )
      continue;
    if (!isStateConfigValue(field, changes[field])) return null;
    const path = field === "arrowMarkerAbsolute" ? [field] : ["state", field];
    const owner = scopes.findLast((scope) => {
      let value: unknown = scope.yaml.values;
      for (const key of [...scope.path, ...path.slice(0, -1)])
        value =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[key]
            : undefined;
      return value && typeof value === "object" && Object.hasOwn(value, field);
    });
    if (owner) {
      const patch = sourceYamlFieldPatch(
        owner.yaml,
        [...owner.path, ...path],
        changes[field],
      );
      if (!patch) return null;
      patches.push(...patch);
    } else missing[field] = changes[field];
  }
  if (Object.keys(missing).length) {
    const header = document.records.find((r) => r.kind === "header");
    if (!header) return null;
    const { arrowMarkerAbsolute, ...state } = missing;
    const init = {
      ...(Object.hasOwn(missing, "arrowMarkerAbsolute")
        ? { arrowMarkerAbsolute }
        : {}),
      ...(Object.keys(state).length ? { state } : {}),
    };
    patches.push({
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify(init)}}%%${document.newline}`,
    });
  }
  return patches;
}

export const STATE_CONFIG_CONSUMERS: Record<
  StateConfigField,
  "geometry" | "text" | "svg"
> = {
  titleTopMargin: "geometry",
  arrowMarkerAbsolute: "svg",
  dividerMargin: "geometry",
  sizeUnit: "geometry",
  padding: "geometry",
  textHeight: "svg",
  titleShift: "svg",
  noteMargin: "geometry",
  nodeSpacing: "geometry",
  rankSpacing: "geometry",
  forkWidth: "geometry",
  forkHeight: "geometry",
  miniPadding: "svg",
  fontSizeFactor: "svg",
  fontSize: "text",
  labelHeight: "svg",
  edgeLengthFactor: "svg",
  compositTitleSize: "svg",
  radius: "geometry",
  defaultRenderer: "svg",
  useMaxWidth: "svg",
};
