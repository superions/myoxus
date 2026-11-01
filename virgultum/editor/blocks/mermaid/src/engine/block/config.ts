// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  readSourceYaml,
  sourceYamlFieldPatch,
  type SourceYaml,
  type SourceValuePatch,
} from "../source-yaml.js";
import type { MermaidBlockNodeSyntax, MermaidBlockShape } from "./model.js";

export const SHAPE_SYNTAX: ReadonlyArray<{
  close: string;
  open: string;
  shape: MermaidBlockShape;
  syntax: MermaidBlockNodeSyntax;
}> = [
  { close: ")))", open: "(((", shape: "doublecircle", syntax: "doublecircle" },
  { close: "]]", open: "[[", shape: "subroutine", syntax: "subroutine" },
  { close: ")]", open: "[(", shape: "database", syntax: "cylinder" },
  { close: "])", open: "([", shape: "stadium", syntax: "stadium" },
  { close: "))", open: "((", shape: "circle", syntax: "circle" },
  { close: "}}", open: "{{", shape: "hexagon", syntax: "hexagon" },
  { close: "/]", open: "[/", shape: "lean-r", syntax: "lean-right" },
  { close: "\\]", open: "[\\", shape: "lean-l", syntax: "lean-left" },
  { close: "\\]", open: "[/", shape: "trap-b", syntax: "trapezoid" },
  { close: "/]", open: "[\\", shape: "trap-t", syntax: "trapezoid-inverted" },
  { close: "]", open: ">", shape: "asymmetric", syntax: "asymmetric" },
  { close: ")", open: "(", shape: "rounded", syntax: "rounded" },
  { close: "}", open: "{", shape: "diamond", syntax: "diamond" },
  { close: "]", open: "[", shape: "rect", syntax: "rectangle" },
];

export const BLOCK_NODE_OPEN_TOKENS = [
  "(((",
  ")))",
  "[[",
  "[|",
  "[(",
  "[\\",
  "[/",
  "{{",
  "((",
  "([",
  "(-",
  "-)",
  "))",
  ">",
  "[",
  "{",
  "(",
  ")",
] as const;

export const BLOCK_NODE_CLOSE_TOKENS = [
  "(((",
  ")))",
  "]]",
  "])",
  "\\]",
  "/]",
  ")]",
  "}}",
  "((",
  "(-",
  "-)",
  "))",
  "]>",
  "]",
  "}",
  ")",
  "(",
] as const;

/** The pinned Block lexer accepts these directions in Source order, including duplicates. */
export const BLOCK_DIRECTIONS = [
  "right",
  "left",
  "up",
  "down",
  "x",
  "y",
] as const;
export type BlockDiagramConfig = { padding: number };
export const BLOCK_DEFAULT_CONFIG: BlockDiagramConfig = { padding: 8 };
export function isBlockColumns(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= -1;
}
export function isBlockSpan(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
export function isBlockPadding(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Invisible is its own production, without endpoint markers or a labelled form. */
export function isBlockConnectionToken(token: string) {
  return /^(?:[xo<]?(?:--+[-xo>]|==+[=xo>]|-?\.+-[xo>]?)|~~~+)$/.test(token);
}
export function isBlockConnectionLabelStart(token: string) {
  return /^[xo<]?(?:--|==|-\.)$/.test(token);
}
export function blockConnectionAppearance(token: string) {
  const marker = (character: string | undefined) =>
    character === "o"
      ? "circle"
      : character === "x"
        ? "cross"
        : character === "<" || character === ">"
          ? "arrow"
          : "none";
  return {
    sourceMarker: marker(
      token[0],
    ) as import("./model.js").MermaidBlockEndpointMarker,
    targetMarker: marker(
      token.at(-1),
    ) as import("./model.js").MermaidBlockEndpointMarker,
    style: (token.includes("==")
      ? "thick"
      : token.includes(".-")
        ? "dotted"
        : "solid") as import("./model.js").MermaidBlockEdgeStyle,
    invisible: token.startsWith("~~~"),
  };
}

export type BlockConfigField = keyof BlockDiagramConfig;
export const BLOCK_CONFIG_FIELDS: BlockConfigField[] = ["padding"];
export function isBlockConfigValue(_field: BlockConfigField, value: unknown) {
  return isBlockPadding(value);
}
type ConfigRecord = {
  kind: string;
  raw: string;
  range: { start: number; end: number };
};
type ConfigDocument = { records: readonly ConfigRecord[]; newline: string };
export function readBlockConfig(document: ConfigDocument) {
  const effective: Record<string, unknown> = { ...BLOCK_DEFAULT_CONFIG };
  const invalidRecords: ConfigRecord[] = [];
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
        ? (/\r\n|\r|\n/.exec(record.raw)?.index ?? -1) +
          (/\r\n|\r|\n/.exec(record.raw)?.[0].length ?? 0)
        : record.raw.indexOf("%%{") + 2;
    const end =
      record.kind === "frontmatter"
        ? record.raw.lastIndexOf("---")
        : record.raw.lastIndexOf("}%%") + 1;
    const yaml = readSourceYaml(
      record.raw.slice(start, end),
      record.range.start + start,
    );
    if (!yaml) {
      invalidRecords.push(record);
      continue;
    }
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
    const block = config.block;
    if (block && typeof block === "object" && !Array.isArray(block))
      for (const field of BLOCK_CONFIG_FIELDS)
        if (Object.hasOwn(block, field))
          effective[field] = (block as Record<string, unknown>)[field];
  }
  const config = { ...BLOCK_DEFAULT_CONFIG },
    invalid: BlockConfigField[] = [];
  for (const field of BLOCK_CONFIG_FIELDS)
    if (isBlockConfigValue(field, effective[field]))
      Object.assign(config, { [field]: effective[field] });
    else invalid.push(field);
  return { config, effective, scopes, invalid, invalidRecords };
}
export function blockConfigPatches(
  document: ConfigDocument,
  changes: Partial<BlockDiagramConfig>,
) {
  const { scopes, effective } = readBlockConfig(document);
  const patches: SourceValuePatch[] = [],
    missing: Record<string, unknown> = {};
  for (const field of BLOCK_CONFIG_FIELDS) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(effective[field], changes[field])
    )
      continue;
    if (!isBlockConfigValue(field, changes[field])) return null;
    const path = ["block", field];
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
    const init = { block: missing };
    patches.push({
      range: { start: header.range.start, end: header.range.start },
      value: `%%{init: ${JSON.stringify(init)}}%%${document.newline}`,
    });
  }
  return patches;
}

export const BLOCK_CONFIG_CONSUMERS = { padding: "geometry" } as const;

/** GUI combinations are candidates, not grammar extensions. Untouched original
 * connector tokens remain at their occurrence instead of being canonicalized. */
export function blockConnectionTokenCandidate(
  style: import("./model.js").MermaidBlockEdgeStyle,
  source: import("./model.js").MermaidBlockEndpointMarker,
  target: import("./model.js").MermaidBlockEndpointMarker,
  invisible = false,
) {
  if (invisible) return "~~~";
  const front =
      source === "arrow"
        ? "<"
        : source === "circle"
          ? "o"
          : source === "cross"
            ? "x"
            : "",
    back =
      target === "arrow"
        ? ">"
        : target === "circle"
          ? "o"
          : target === "cross"
            ? "x"
            : "";
  const token =
    front +
    (style === "dotted" ? "-.-" : style === "thick" ? "===" : "---") +
    back;
  return isBlockConnectionToken(token) ? token : null;
}
