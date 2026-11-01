// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceYamlFieldPatch } from "../../source-yaml.js";
import {
  C4_CONFIG_FIELDS,
  c4ConfigHasRendererEffect,
  isC4ConfigValue,
  readC4Config,
} from "../config.js";
import type { MermaidC4Config } from "../runtime-contract.js";
import type { MermaidC4Model, MermaidC4Argument } from "../model.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import { c4CallPatch, insertC4Record } from "../record-writer.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

function allScopes(model: MermaidC4Model) {
  return [null, ...model.boundaries.map((b) => b.resolution!.selectionId)];
}
/** Patch actual YAML providers. Missing fields get a named native init namespace,
 * respecting legacy config precedence without rewriting unrelated authored config. */
export function editC4Configuration(
  model: MermaidC4Model,
  values: Readonly<Partial<MermaidC4Config>>,
) {
  const entries = Object.entries(values);
  const initial = readC4Config(model.sourceDocument);
  const changed = entries.filter(
    ([field, value]) => !Object.is(initial.effective[field], value),
  );
  if (
    entries.some(
      ([key, value]) =>
        !(C4_CONFIG_FIELDS as readonly string[]).includes(key) ||
        !isC4ConfigValue(key as keyof MermaidC4Config, value),
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  if (
    changed.some(
      ([field]) =>
        !c4ConfigHasRendererEffect(field as keyof MermaidC4Config, {
          ...initial.config,
          ...values,
        }),
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  let next = { source: model.sourceDocument.source, model };
  const missing: Record<string, unknown> = Object.create(null);
  try {
    for (const [field, value] of entries) {
      const config = readC4Config(next.model.sourceDocument);
      if (Object.is(config.effective[field], value)) continue;
      const provider = config.providers[field];
      if (!provider) {
        missing[field] = value;
        continue;
      }
      const owner = config.scopes.find(
        (s) => s.record.sourceKey === provider.sourceKey,
      );
      const patches =
        owner && sourceYamlFieldPatch(owner.yaml, provider.path, value);
      if (!patches)
        throw new C4WriteError("C4 configuration provider cannot be patched");
      next = writeC4Patches(
        next.model,
        patches.map((p) => ({
          start: p.range.start,
          end: p.range.end,
          text: p.value,
        })),
      );
    }
    if (Object.keys(missing).length) {
      const config = readC4Config(next.model.sourceDocument);
      if (config.invalidDirectives || config.invalidContainers.length)
        throw new C4WriteError("Repair the native configuration owner first");
      const legacy = config.scopes.some((s) => {
        const root = s.yaml.values[s.path[0]];
        return (
          s.record.kind === "directive" &&
          root &&
          typeof root === "object" &&
          Object.hasOwn(root, "config")
        );
      });
      const at = next.model.sourceDocument.records.find(
        (r) => r.kind === "header",
      )!.range.start;
      next = writeC4Patches(next.model, [
        {
          start: at,
          end: at,
          text: `%%{init: ${JSON.stringify({ [legacy ? "config" : "c4"]: missing })}}%%${next.model.sourceDocument.newline}`,
        },
      ]);
    }
    const actual = readC4Config(next.model.sourceDocument);
    if (
      entries.some(
        ([field, value]) => !Object.is(actual.effective[field], value),
      )
    )
      throw new C4WriteError(
        "The chosen native config namespace shadows the edit",
      );
    const result = c4CommandResult(model, next);
    if (
      result.status === "changed" &&
      changed.some(
        ([field]) => !field.endsWith("_color") && field !== "useMaxWidth",
      )
    ) {
      result.reflowScopes = allScopes(next.model);
      result.measureContent = true;
    }
    return result;
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}

export type C4LayoutRows = { shapes: number; boundaries: number };
/** Row getters belong to UpdateLayoutConfig, never config.c4's ignored row names. */
export function editC4LayoutRows(
  model: MermaidC4Model,
  values: Readonly<Partial<C4LayoutRows>>,
) {
  if (
    Object.entries(values).some(
      ([field, value]) =>
        !["shapes", "boundaries"].includes(field) ||
        !Number.isSafeInteger(value) ||
        value < 1,
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  const calls = new Map<string, MermaidC4Argument[]>(),
    missing: MermaidC4Argument[] = [];
  for (const [field, index, nativeField, current] of [
    ["shapes", 0, "c4ShapeInRow", model.layoutShapeInRow],
    ["boundaries", 1, "c4BoundaryInRow", model.layoutBoundaryInRow],
  ] as const) {
    const value = values[field];
    if (value === undefined || current === value) continue;
    const occurrence = model.occurrences.find(
      (o) =>
        o.kind === "UpdateLayoutConfig" &&
        o.effectiveFields.includes(nativeField),
    );
    const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === occurrence?.sourceKey,
    );
    if (record?.arguments?.[index]) {
      const args =
        calls.get(record.sourceKey) ?? record.arguments.map((a) => ({ ...a }));
      args[index] = { ...args[index], value: String(value) };
      calls.set(record.sourceKey, args);
    } else {
      while (missing.length <= index) missing.push({ key: "", value: "" });
      missing[index] = { key: "", value: String(value) };
    }
  }
  try {
    let next = writeC4Patches(
      model,
      [...calls].map(([key, args]) =>
        c4CallPatch(model, key, "UpdateLayoutConfig", args),
      ),
    );
    if (missing.length)
      next = insertC4Record(
        next.model,
        { parentKey: null },
        `UpdateLayoutConfig(${missing.map((a) => JSON.stringify(a.value)).join(", ")})`,
      );
    const result = c4CommandResult(model, next);
    if (result.status === "changed")
      result.reflowScopes = allScopes(next.model);
    return result;
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
