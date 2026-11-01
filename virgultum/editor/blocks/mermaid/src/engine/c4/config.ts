// SPDX-License-Identifier: AGPL-3.0-or-later

import { readSourceYaml, type SourceYaml } from "../source-yaml.js";
import {
  C4_CALLS,
  C4_CONFIG_BOOLEAN_FIELDS,
  C4_CONFIG_GEOMETRY,
  C4_CONFIG_GENERIC_FONTS,
  C4_CONFIG_FONT_OWNERS,
  C4_CONFIG_FONT_FIELDS,
  C4_CONFIG_COLOR_FIELDS,
  C4_CONFIG_IGNORED_ROW_FIELDS,
  type MermaidC4Config,
} from "./runtime-contract.js";
import type { C4SourceDocument, C4SourceRecord } from "./source-document.js";

export type C4ConfigField = keyof MermaidC4Config;
export const C4_CONFIG_FIELDS = [
  ...C4_CONFIG_GEOMETRY,
  ...C4_CONFIG_GENERIC_FONTS,
  ...C4_CONFIG_FONT_OWNERS.flatMap((owner) =>
    C4_CONFIG_FONT_FIELDS.map((field) => `${owner}${field}`),
  ),
  ...Object.values(C4_CALLS)
    .filter((c) => c.category === "element")
    .flatMap((c) =>
      C4_CONFIG_COLOR_FIELDS.map((field) => `${c.nativeType}${field}`),
    ),
] as readonly C4ConfigField[];
export type C4ConfigScope = {
  record: C4SourceRecord;
  yaml: SourceYaml;
  path: string[];
};
export type C4ConfigProvider = { sourceKey: string; path: readonly string[] };
export function isC4ConfigValue(field: C4ConfigField, value: unknown) {
  if ((C4_CONFIG_BOOLEAN_FIELDS as readonly string[]).includes(field))
    return typeof value === "boolean";
  if ((C4_CONFIG_GEOMETRY as readonly string[]).includes(field))
    return typeof value === "number" && Number.isFinite(value);
  if (
    /FontSize$|FontWeight$/.test(field) ||
    field === "fontSize" ||
    field === "fontWeight"
  )
    return (
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    );
  return typeof value === "string";
}
/** Authored config stays with its YAML owner. No client default palette or row override is introduced. */
export function readC4Config(document: C4SourceDocument) {
  const effective: Record<string, unknown> = Object.create(null),
    providers: Record<string, C4ConfigProvider> = Object.create(null),
    scopes: C4ConfigScope[] = [];
  const frontmatter: Array<{
      scope: C4ConfigScope;
      values: Record<string, unknown>;
    }> = [],
    directives: typeof frontmatter = [];
  let invalidDirectives = false;
  const object = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value));
  for (const record of document.records.filter(
    (r) => r.kind === "frontmatter" || r.kind === "directive",
  )) {
    if (
      record.kind === "directive" &&
      !/^%%\{\s*(init|initialize)\s*:/.test(record.raw.trim())
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
    let native: unknown;
    if (record.kind === "directive") {
      // One malformed init invalidates native detectDirective's complete batch.
      try {
        native = JSON.parse(
          record.raw
            .slice(record.raw.indexOf(":", start) + 1, end - 1)
            .trim()
            .replaceAll("'", '"'),
        );
      } catch {
        invalidDirectives = true;
        continue;
      }
    }
    const yaml = readSourceYaml(
      record.raw.slice(start, end),
      record.range.start + start,
      { allowDuplicateKeys: record.kind === "directive" },
    );
    if (!yaml) continue;
    const prefix =
      record.kind === "frontmatter"
        ? "config"
        : Object.hasOwn(yaml.values, "init")
          ? "init"
          : "initialize";
    const root: unknown =
      record.kind === "directive" ? native : yaml.values[prefix];
    if (!object(root)) continue;
    const scope = { record, yaml, path: [prefix] };
    scopes.push(scope);
    if (record.kind === "frontmatter")
      frontmatter.push({ scope, values: root });
    else directives.push({ scope, values: root });
  }
  if (invalidDirectives) directives.length = 0;
  const invalidContainers: C4ConfigProvider[] = [];
  const apply = (field: string, value: unknown, owner: C4ConfigProvider) => {
    effective[field] = value;
    providers[field] = owner;
  };
  for (const entry of frontmatter)
    if (object(entry.values.c4))
      for (const [field, value] of Object.entries(entry.values.c4))
        apply(field, value, {
          sourceKey: entry.scope.record.sourceKey,
          path: [...entry.scope.path, "c4", field],
        });
  // Native detectInit merges directives before mapping legacy config onto c4.
  // With several directives its depth-limited merge ignores null and cannot
  // replace an existing object with a scalar (or a scalar with an object).
  const merge = (member: "c4" | "config") => {
    let value: unknown;
    const fields: Record<string, unknown> = Object.create(null),
      owners: Record<string, C4ConfigProvider> = Object.create(null);
    let containerOwner: C4ConfigProvider | undefined;
    for (const entry of directives) {
      if (!Object.hasOwn(entry.values, member)) continue;
      const next = entry.values[member],
        path = [...entry.scope.path, member],
        owner = { sourceKey: entry.scope.record.sourceKey, path };
      if (directives.length > 1 && next === null) continue;
      if (value === undefined) {
        value = object(next) ? fields : next;
        containerOwner = owner;
      }
      if (object(value) && object(next))
        for (const [field, leaf] of Object.entries(next)) {
          if (
            directives.length > 1 &&
            (leaf === null ||
              (typeof fields[field] === "object" && typeof leaf !== "object") ||
              (typeof fields[field] !== "object" &&
                fields[field] !== undefined &&
                typeof leaf === "object"))
          )
            continue;
          fields[field] =
            object(leaf) && object(fields[field])
              ? { ...fields[field], ...leaf }
              : leaf;
          owners[field] = {
            sourceKey: owner.sourceKey,
            path: [...path, field],
          };
        }
      else if (typeof value !== "object" && typeof next !== "object") {
        value = next;
        containerOwner = owner;
      }
    }
    return { value, fields, owners, containerOwner };
  };
  const legacy = merge("config"),
    direct = merge("c4"),
    selected = legacy.value !== undefined ? legacy : direct;
  if (object(selected.value))
    for (const [field, value] of Object.entries(selected.fields))
      apply(field, value, selected.owners[field]);
  else if (selected.containerOwner) {
    invalidContainers.push(selected.containerOwner);
    // A non-mapping native namespace replaces the frontmatter namespace.
    // Retain its Source owner for correction rather than claiming base effects.
    for (const field of Object.keys(effective)) {
      delete effective[field];
      delete providers[field];
    }
  }
  const config: MermaidC4Config = {},
    invalid: C4ConfigField[] = [];
  for (const field of C4_CONFIG_FIELDS)
    if (Object.hasOwn(effective, field)) {
      if (isC4ConfigValue(field, effective[field]))
        Object.assign(config, { [field]: effective[field] });
      else invalid.push(field);
    }
  const unknown = Object.keys(effective).filter(
    (field) => !(C4_CONFIG_FIELDS as readonly string[]).includes(field),
  );
  const ignoredRows = C4_CONFIG_IGNORED_ROW_FIELDS.filter((field) =>
    Object.hasOwn(effective, field),
  );
  return {
    config,
    effective,
    providers,
    scopes,
    invalid,
    unknown,
    ignoredRows,
    invalidContainers,
    invalidDirectives,
  };
}

/** 11.17.2's unified element adapter does not consume legacy element fonts,
 * boxMargin or wrapPadding. Keep their Source values without advertising an effect. */
export const C4_RENDERED_CONFIG_FIELDS = C4_CONFIG_FIELDS.filter(
  (field) =>
    !["boxMargin", "wrapPadding", "height"].includes(field) &&
    (!/Font(Family|Size|Weight)$/.test(field) ||
      /^(boundary|message)Font/.test(field)),
);
export function c4ConfigHasRendererEffect(
  field: C4ConfigField,
  config: MermaidC4Config,
) {
  if (!C4_RENDERED_CONFIG_FIELDS.includes(field)) return false;
  if (field.startsWith("messageFont")) {
    const generic = `font${field.slice("messageFont".length)}` as
      "fontFamily" | "fontSize" | "fontWeight";
    return !config[generic];
  }
  return true;
}
