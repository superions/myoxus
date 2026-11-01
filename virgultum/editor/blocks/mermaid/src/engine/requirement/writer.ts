// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRequirementElement,
  MermaidRequirementModel,
  MermaidRequirementNode,
} from "./model.js";
import {
  sourceRequirementString,
  readRequirementString,
} from "./runtime-contract.js";
import type { RequirementPropertyName } from "./runtime-contract.js";
import { resolveMermaidRequirementSource } from "./parser.js";
import type { RequirementSourceRecord } from "./source-document.js";
import type { SourceValuePatch } from "../source-yaml.js";
import { hashMermaidSource } from "../source-hash.js";

function sourceRequirementObject(
  item: MermaidRequirementNode | MermaidRequirementElement,
  namespace: "requirement" | "element",
  newline: string,
) {
  const kind =
    namespace === "requirement"
      ? (item as MermaidRequirementNode).requirementType
      : "element";
  const lines = [`  ${kind} ${sourceRequirementString(item.name)} {`];
  for (const [property, field] of fields)
    if (field in item) {
      const value = String(item[field as keyof typeof item]);
      if (value !== "")
        lines.push(
          `    ${property}: ${property === "risk" || property === "verifymethod" ? value : sourceRequirementString(value)}`,
        );
    }
  lines.push("  }");
  return lines.join(newline) + newline;
}

function generateNewRequirementSource(model: MermaidRequirementModel) {
  const lines = [
    ...model.directives.filter((line) => line.trim()),
    model.headerLine || "requirementDiagram",
  ];
  for (const requirement of [...model.requirements].sort(
    (a, b) => a.order - b.order,
  )) {
    lines.push(
      sourceRequirementObject(requirement, "requirement", "\n").slice(0, -1),
    );
  }
  for (const element of [...model.elements].sort((a, b) => a.order - b.order)) {
    lines.push(sourceRequirementObject(element, "element", "\n").slice(0, -1));
  }
  for (const relation of [...model.relations].sort(
    (a, b) => a.order - b.order,
  )) {
    lines.push(
      relation.sourceForm === "left"
        ? `  ${sourceRequirementString(relation.to)} <- ${relation.kind} - ${sourceRequirementString(relation.from)}`
        : `  ${sourceRequirementString(relation.from)} - ${relation.kind} -> ${sourceRequirementString(relation.to)}`,
    );
  }
  lines.push(...model.sourceAnnotations.filter((line) => line.trim()));
  return `${lines.join("\n")}\n`;
}

export type RequirementPatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type RequirementWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "confirm" | "preview" | "cancel";
  removed?: ReadonlySet<string>;
  selection?: string;
};
export type RequirementCommandResult = {
  status: "changed" | "no-op" | "rejected";
  reason:
    "applied" | "no-change" | "invalid" | "conflict" | "readonly" | "cancelled";
  changed: boolean;
  source: string;
  model: MermaidRequirementModel;
  patches: readonly RequirementPatch[];
  selection?: string;
  diagnostic?: import("./diagnostics.js").RequirementSourceDiagnostic;
};
export function requirementNoChange(
  model: MermaidRequirementModel,
  reason: Exclude<RequirementCommandResult["reason"], "applied"> = "no-change",
): RequirementCommandResult {
  return {
    status:
      reason === "no-change" || reason === "cancelled" ? "no-op" : "rejected",
    reason,
    changed: false,
    source: model.sourceDocument?.source ?? "",
    model,
    patches: [],
  };
}

/** Validate once against the opening Source, then return the checked Source and
 * advanced record bindings together. A host commits this result, never a second
 * writer pass against its pre-write Source. */
export function writeRequirementPatches(
  model: MermaidRequirementModel,
  patches: readonly RequirementPatch[],
  options: RequirementWriteOptions = {},
): RequirementCommandResult {
  const document = model.sourceDocument;
  if (!document) return requirementNoChange(model, "invalid");
  const source = document.source;
  if (options.intent === "cancel")
    return requirementNoChange(model, "cancelled");
  if (options.readonly) return requirementNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return requirementNoChange(model, "conflict");
  const unique = new Map(
    patches.map((p) => [`${p.range.start}:${p.range.end}:${p.value}`, p]),
  );
  const sorted = [...unique.values()].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>(),
    reserved = new Set<string>();
  let next = "",
    cursor = 0;
  for (const patch of sorted) {
    if (
      !Number.isSafeInteger(patch.range.start) ||
      !Number.isSafeInteger(patch.range.end) ||
      patch.range.start < cursor ||
      patch.range.end < patch.range.start ||
      patch.range.end > source.length
    )
      return requirementNoChange(model, "invalid");
    next += source.slice(cursor, patch.range.start);
    for (const [offset, key] of patch.identities ?? []) {
      if (offset < 0 || offset > patch.value.length || reserved.has(key))
        return requirementNoChange(model, "invalid");
      mapping.set(next.length + offset, key);
      reserved.add(key);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  if (next === source) return requirementNoChange(model);
  for (const record of document.records) {
    if (
      reserved.has(record.sourceKey) ||
      options.removed?.has(record.sourceKey)
    )
      continue;
    let offset = record.range.start,
      removed = false;
    for (const patch of sorted) {
      if (patch.range.start > record.range.start) break;
      if (
        patch.range.end > patch.range.start &&
        record.range.start < patch.range.end
      ) {
        if (
          patch.range.start === record.range.start &&
          patch.value &&
          patch.range.end <= record.range.end
        )
          break;
        removed = true;
        break;
      }
      offset += patch.value.length - (patch.range.end - patch.range.start);
    }
    if (!removed) mapping.set(offset, record.sourceKey);
  }
  const parsed = resolveMermaidRequirementSource(next, document, mapping);
  if (!parsed.model)
    return {
      ...requirementNoChange(model, "invalid"),
      diagnostic: parsed.diagnostics.find((d) => d.severity === "error"),
    };
  const keys = new Set(parsed.document.records.map((r) => r.sourceKey));
  for (const r of document.records)
    if (!options.removed?.has(r.sourceKey) && !keys.has(r.sourceKey))
      return requirementNoChange(model, "invalid");
  // Opaque editor IDs survive semantic rename/reconnect. Source aliases remain
  // the native references, and Source keys remain the write identities.
  for (const [before, after] of [
    [model.requirements, parsed.model.requirements],
    [model.elements, parsed.model.elements],
    [model.relations, parsed.model.relations],
  ] as const) {
    const ids = new Map(
      before
        .filter((item) => item.sourceKey)
        .map((item) => [item.sourceKey, item.id]),
    );
    for (const item of after) item.id = ids.get(item.sourceKey) ?? item.id;
  }
  const reqs = new Map(parsed.model.requirements.map((n) => [n.name, n.id])),
    els = new Map(parsed.model.elements.map((n) => [n.name, n.id]));
  for (const relation of parsed.model.relations) {
    relation.fromId = reqs.get(relation.from) ?? els.get(relation.from);
    relation.toId = reqs.get(relation.to) ?? els.get(relation.to);
  }
  return {
    status: "changed",
    reason: "applied",
    changed: true,
    source: next,
    model: parsed.model,
    patches: sorted,
    selection: options.selection,
  };
}

export function requirementRecordEnd(record: RequirementSourceRecord) {
  return record.range.end + record.eol.length;
}
export function requirementRecord(model: MermaidRequirementModel, key: string) {
  return model.sourceDocument?.records.find((r) => r.sourceKey === key);
}

function stringValue(value: string, previous = "") {
  return previous.startsWith('"')
    ? `"${value.replaceAll('"', "#quot;")}"`
    : sourceRequirementString(value);
}
type RequirementObject = MermaidRequirementNode | MermaidRequirementElement;
const fields: ReadonlyArray<
  readonly [
    RequirementPropertyName,
    keyof MermaidRequirementNode | keyof MermaidRequirementElement,
  ]
> = [
  ["id", "requirementId"],
  ["text", "text"],
  ["risk", "risk"],
  ["verifymethod", "verifyMethod"],
  ["type", "elementType"],
  ["docref", "docRef"],
];

/** Adapt the existing model/GFX CRUD port to owning record patches. Geometry and
 * absent fields are not Source changes; ignored definitions/styles are retained. */
export function writeRequirementModel(
  base: MermaidRequirementModel,
  desired: MermaidRequirementModel,
  options: RequirementWriteOptions = {},
): RequirementCommandResult {
  const document = base.sourceDocument;
  if (!document) return requirementNoChange(base, "invalid");
  const patches: RequirementPatch[] = [],
    removed = new Set<string>(options.removed);
  const deletedAliases = new Set<string>(),
    renamedAliases = new Map<string, string>();
  const replace = (range: { start: number; end: number }, value: string) => {
    if (document.source.slice(range.start, range.end) !== value)
      patches.push({ range, value });
  };
  const removeRecord = (r: RequirementSourceRecord) => {
    removed.add(r.sourceKey);
    replace({ start: r.range.start, end: requirementRecordEnd(r) }, "");
  };
  const add = (text: string) => {
    const offset = document.source.length,
      prefix =
        offset && !/[\r\n]$/.test(document.source) ? document.newline : "";
    patches.push({
      range: { start: offset, end: offset },
      value: prefix + text,
    });
  };
  for (const [namespace, before, after] of [
    ["requirement", base.requirements, desired.requirements],
    ["element", base.elements, desired.elements],
  ] as const) {
    for (const old of before) {
      const item = after.find(
        (item) =>
          (old.sourceKey && item.sourceKey === old.sourceKey) ||
          item.id === old.id,
      ) as RequirementObject | undefined;
      const open = requirementRecord(base, old.sourceKey ?? "");
      if (!open) return requirementNoChange(base, "invalid");
      if (!item) {
        for (const definition of document.records.filter(
          (r) =>
            r.kind === "object-open" &&
            r.namespace === namespace &&
            r.ownerId === old.name,
        )) {
          const close =
            definition.closeKey && requirementRecord(base, definition.closeKey);
          if (!close) return requirementNoChange(base, "invalid");
          const end = requirementRecordEnd(close);
          for (const r of document.records)
            if (r.range.start >= definition.range.start && r.range.start < end)
              removed.add(r.sourceKey);
          replace({ start: definition.range.start, end }, "");
        }
        if (
          ![...desired.requirements, ...desired.elements].some(
            (n) => n.name === old.name,
          )
        )
          deletedAliases.add(old.name);
        continue;
      }
      if (old.name !== item.name) {
        if (
          readRequirementString(sourceRequirementString(item.name)) !==
            item.name ||
          document.records.some(
            (record) =>
              record.kind === "object-open" && record.ownerId === item.name,
          )
        )
          return requirementNoChange(base, "invalid");
        for (const definition of document.records.filter(
          (r) =>
            r.kind === "object-open" &&
            r.namespace === namespace &&
            r.ownerId === old.name,
        )) {
          const range = definition.values.alias!;
          replace(
            range,
            stringValue(
              item.name,
              document.source.slice(range.start, range.end),
            ),
          );
        }
        if (
          ![...base.requirements, ...base.elements].some(
            (n) => n !== old && n.name === old.name,
          )
        )
          renamedAliases.set(old.name, item.name);
      }
      if (
        namespace === "requirement" &&
        (old as MermaidRequirementNode).requirementType !==
          (item as MermaidRequirementNode).requirementType
      )
        replace(
          open.values.kind!,
          (item as MermaidRequirementNode).requirementType,
        );
      for (const [property, field] of fields) {
        if (!(field in old) || !(field in item)) continue;
        const beforeValue = String(old[field as keyof typeof old]),
          value = String(item[field as keyof typeof item]);
        if (beforeValue === value) continue;
        const key = old.propertyKeys?.[property]?.[0],
          record = key ? requirementRecord(base, key) : undefined;
        const sourceValue =
          property === "risk" || property === "verifymethod"
            ? value
            : stringValue(
                value,
                record?.values.value
                  ? document.source.slice(
                      record.values.value.start,
                      record.values.value.end,
                    )
                  : "",
              );
        if (record?.values.value) replace(record.values.value, sourceValue);
        else {
          const close = open.closeKey && requirementRecord(base, open.closeKey);
          if (!close) return requirementNoChange(base, "invalid");
          patches.push({
            range: { start: close.range.start, end: close.range.start },
            value: `${open.indent}  ${property}: ${sourceValue}${document.newline}`,
          });
        }
      }
    }
    for (const item of after) {
      if (
        before.some(
          (old) =>
            (old.sourceKey && old.sourceKey === item.sourceKey) ||
            old.id === item.id,
        )
      )
        continue;
      add(sourceRequirementObject(item, namespace, document.newline));
    }
  }
  for (const old of base.relations) {
    const relation = desired.relations.find(
      (r) =>
        (old.sourceKey && r.sourceKey === old.sourceKey) || r.id === old.id,
    );
    const record = requirementRecord(base, old.sourceKey ?? "");
    if (!record) return requirementNoChange(base, "invalid");
    if (!relation) {
      removeRecord(record);
      continue;
    }
    const from = renamedAliases.get(relation.from) ?? relation.from,
      to = renamedAliases.get(relation.to) ?? relation.to;
    const left = old.sourceForm === "left" ? to : from,
      right = old.sourceForm === "left" ? from : to;
    for (const [name, value, previous] of [
      ["left", left, old.sourceForm === "left" ? old.to : old.from],
      ["right", right, old.sourceForm === "left" ? old.from : old.to],
    ] as const) {
      if (value !== previous) {
        const range = record.values[name]!;
        replace(
          range,
          stringValue(value, document.source.slice(range.start, range.end)),
        );
      }
    }
    if (relation.kind !== old.kind)
      replace(record.values.relationship!, relation.kind);
  }
  for (const relation of desired.relations)
    if (
      !base.relations.some(
        (old) =>
          (old.sourceKey && old.sourceKey === relation.sourceKey) ||
          old.id === relation.id,
      )
    )
      add(
        relation.sourceForm === "left"
          ? `  ${sourceRequirementString(relation.to)} <- ${relation.kind} - ${sourceRequirementString(relation.from)}${document.newline}`
          : `  ${sourceRequirementString(relation.from)} - ${relation.kind} -> ${sourceRequirementString(relation.to)}${document.newline}`,
      );
  for (const record of document.records) {
    if (
      !["style", "style-assignment", "inline-class"].includes(record.kind) ||
      removed.has(record.sourceKey)
    )
      continue;
    const references = record.references,
      kept = references.filter((ref) => !deletedAliases.has(ref.id));
    if (references.length && !kept.length) {
      removeRecord(record);
      continue;
    }
    for (let i = 0; i < references.length; i++) {
      const ref = references[i]!;
      if (deletedAliases.has(ref.id)) {
        const start = i;
        while (
          i + 1 < references.length &&
          deletedAliases.has(references[i + 1]!.id)
        )
          i++;
        const next = references[i + 1],
          previous = references[start - 1];
        replace(
          {
            start: next ? references[start]!.range.start : previous!.range.end,
            end: next ? next.range.start : references[i]!.range.end,
          },
          "",
        );
      } else {
        const alias = renamedAliases.get(ref.id);
        if (alias)
          replace(
            ref.range,
            stringValue(
              alias,
              document.source
                .slice(ref.range.start, ref.range.end)
                .startsWith('"') || !/^\w+$/.test(alias)
                ? '"'
                : "",
            ),
          );
      }
    }
  }
  return writeRequirementPatches(base, patches, { ...options, removed });
}

export function generateMermaidRequirementSource(
  model: MermaidRequirementModel,
) {
  if (!model.sourceDocument) {
    if (model.sourceHash !== hashMermaidSource(""))
      throw new Error("Cannot regenerate existing Requirement Source");
    return generateNewRequirementSource(model);
  }
  const base = resolveMermaidRequirementSource(
    model.sourceDocument.source,
    model.sourceDocument,
  ).model;
  return base
    ? writeRequirementModel(base, model).source
    : model.sourceDocument.source;
}
