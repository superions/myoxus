// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  readSourceYaml,
  sourceYamlFieldPatch,
  sourceFrontmatter,
  restoreFrontmatterPrefix,
  type SourceYaml,
} from "../../source-yaml.js";
import type { MermaidMindmapModel } from "../model.js";
import {
  unchangedMindmap,
  writeMindmapPatches,
  type MindmapCommandOptions,
  type MindmapPatch,
} from "../writer.js";

export type MindmapNativeConfig = {
  padding: number;
  maxNodeWidth: number;
  useMaxWidth: boolean;
};
// Pinned Mermaid 11.17.2 defaults. These are native SVG options, not GFX geometry.
export const MINDMAP_NATIVE_DEFAULTS: MindmapNativeConfig = {
  padding: 10,
  maxNodeWidth: 200,
  useMaxWidth: true,
};
const fields = ["padding", "maxNodeWidth", "useMaxWidth"] as const;
type Scope = {
  yaml: SourceYaml;
  path: string[];
  values: Record<string, unknown>;
  prefix: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function valid(field: keyof MindmapNativeConfig, value: unknown) {
  return field === "useMaxWidth"
    ? typeof value === "boolean"
    : typeof value === "number" &&
        Number.isFinite(value) &&
        value >= (field === "maxNodeWidth" ? 1 : 0);
}

/** Native config precedence follows the existing Sequence config/CST pattern:
 * frontmatter first, then authored init/initialize directives in Source order. */
export function readMindmapNativeConfig(model: MermaidMindmapModel) {
  const source = model.sourceDocument.source;
  const scopes: Scope[] = [];
  const front = sourceFrontmatter(source);
  if (front) {
    const yaml = readSourceYaml(front.body, front.start);
    if (yaml && object(yaml.values.config))
      scopes.push({
        yaml,
        path: ["config"],
        values: yaml.values.config,
        prefix: front.prefix,
      });
  }
  for (const match of source.matchAll(
    /%%\{\s*(?:init|initialize)\s*:[\s\S]*?\}%%/gi,
  )) {
    // A quoted label containing directive-looking text is not a config owner.
    const record = model.sourceDocument.records.find(
      (record) =>
        record.range.start <= match.index && record.range.end >= match.index,
    );
    if (
      !record ||
      (record.kind !== "preamble" && record.kind !== "comment") ||
      (front && match.index < front.closingStart)
    )
      continue;
    const yaml = readSourceYaml(match[0].slice(2, -2), match.index + 2);
    if (!yaml) continue;
    const name = Object.hasOwn(yaml.values, "init") ? "init" : "initialize";
    let values = yaml.values[name];
    if (!object(values)) continue;
    const path = [name];
    if (object(values.config)) {
      values = values.config;
      path.push("config");
    }
    if (object(values)) scopes.push({ yaml, path, values, prefix: "" });
  }
  const effective: Record<string, unknown> = { ...MINDMAP_NATIVE_DEFAULTS };
  for (const scope of scopes)
    if (object(scope.values.mindmap))
      for (const field of fields)
        if (Object.hasOwn(scope.values.mindmap, field))
          effective[field] = scope.values.mindmap[field];
  const config = { ...MINDMAP_NATIVE_DEFAULTS },
    invalid: Array<keyof MindmapNativeConfig> = [];
  for (const field of fields) {
    if (valid(field, effective[field]))
      Object.assign(config, { [field]: effective[field] });
    else invalid.push(field);
  }
  return { config, effective, invalid, scopes };
}

/** Patch the effective owning YAML map once, including aliased maps. Unknown
 * keys, comments and unconsumed layoutAlgorithm bytes remain with that owner. */
export function editMindmapNativeConfig(
  model: MermaidMindmapModel,
  changes: Partial<MindmapNativeConfig>,
  options: MindmapCommandOptions = {},
) {
  const { scopes, effective } = readMindmapNativeConfig(model);
  const edits = new Map<Scope, Record<string, unknown>>(),
    missing: Record<string, unknown> = {};
  for (const field of fields) {
    if (
      !Object.hasOwn(changes, field) ||
      Object.is(effective[field], changes[field])
    )
      continue;
    if (!valid(field, changes[field])) return unchangedMindmap(model, "syntax");
    const owner = scopes.findLast(
      (scope) =>
        object(scope.values.mindmap) &&
        Object.hasOwn(scope.values.mindmap, field),
    );
    if (!owner) {
      missing[field] = changes[field];
      continue;
    }
    const values = edits.get(owner) ?? {
      ...(object(owner.values.mindmap) ? owner.values.mindmap : {}),
    };
    values[field] = changes[field];
    edits.set(owner, values);
  }
  const patches: MindmapPatch[] = [];
  for (const [scope, value] of edits) {
    const changed = sourceYamlFieldPatch(
      scope.yaml,
      [...scope.path, "mindmap"],
      value,
    );
    if (!changed) return unchangedMindmap(model, "syntax");
    patches.push(
      ...changed.map((patch) => ({
        start: patch.range.start,
        end: patch.range.end,
        text: restoreFrontmatterPrefix(patch.value, scope.prefix),
      })),
    );
  }
  if (Object.keys(missing).length) {
    const header = model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    if (!header) return unchangedMindmap(model, "syntax");
    patches.push({
      start: header.range.start,
      end: header.range.start,
      text: `%%{init: ${JSON.stringify({ mindmap: missing })}}%%${model.sourceDocument.newline}`,
    });
  }
  return writeMindmapPatches(model, patches, options);
}
