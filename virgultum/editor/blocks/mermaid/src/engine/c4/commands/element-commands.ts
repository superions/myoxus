// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as m } from "../../../i18n.js";
import {
  C4_ELEMENT_KINDS,
  C4_CALLS,
  isC4ElementKind,
  c4CallSource,
} from "../runtime-contract.js";
import {
  c4CallPatch,
  insertC4Record,
  type C4InsertTarget,
} from "../record-writer.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import { c4CommandResult, c4NoChange, type C4CommandResult } from "./model.js";
import type { MermaidC4Model } from "../model.js";
import { cloneC4Model } from "./model.js";

export function renameMermaidC4Element(
  model: MermaidC4Model,
  elementId: string,
  label: string,
) {
  const next = cloneC4Model(model);
  const element = next.elements.find((candidate) => candidate.id === elementId);
  if (element) element.label = label.trim() || element.alias;
  return next;
}

/** Recommendation is a palette hint; every grammar-valid kind remains available. */
export function c4ElementKindCatalog(header: string) {
  const prefix =
    header === "C4Context"
      ? "System"
      : header === "C4Component"
        ? "Component"
        : "Container";
  const recommended = C4_ELEMENT_KINDS.filter(
    (kind) =>
      kind === "Person" || kind === "Person_Ext" || kind.startsWith(prefix),
  );
  return {
    initialKind: prefix as "System" | "Component" | "Container",
    recommended,
    additional: C4_ELEMENT_KINDS.filter((kind) => !recommended.includes(kind)),
  };
}
export function nextC4ElementAlias(model: MermaidC4Model, kind: string) {
  const used = new Set([
    "global",
    ...model.elements.map((e) => e.alias),
    ...model.boundaries.map((b) => b.alias),
  ]);
  // Latent references must not become effective when a new object is inserted.
  for (const record of model.sourceDocument.records) {
    const contract = record.callKind && C4_CALLS[record.callKind];
    if (!contract) continue;
    record.arguments?.forEach((argument, index) => {
      if (
        contract.ignoredSlots?.includes(index) ||
        index >= contract.slots.length
      )
        return;
      const field =
        argument.named || argument.key ? argument.key : contract.slots[index];
      if (
        (index === 0 &&
          (contract.category === "element" ||
            contract.category === "boundary" ||
            record.callKind === "UpdateElementStyle")) ||
        ["alias", "from", "to", "elementName", "parentBoundary"].includes(field)
      )
        used.add(argument.value);
    });
  }
  const stem = kind[0].toLowerCase() + kind.slice(1);
  let alias = stem,
    index = 2;
  while (used.has(alias)) alias = `${stem}${index++}`;
  return alias;
}
export type C4ElementCreate = {
  kind: (typeof C4_ELEMENT_KINDS)[number];
  label: string;
  alias?: string;
  target: C4InsertTarget;
};
export function createC4Element(
  model: MermaidC4Model,
  value: C4ElementCreate,
): C4CommandResult {
  if (!isC4ElementKind(value.kind))
    return c4NoChange(model, m.classPatchRejected());
  const alias = value.alias ?? nextC4ElementAlias(model, value.kind);
  if (
    !alias ||
    alias === "global" ||
    [...model.elements, ...model.boundaries].some((e) => e.alias === alias)
  )
    return c4NoChange(model, m.classPatchRejected());
  const parent = value.target.parentKey
    ? model.sourceDocument.records.find(
        (r) =>
          r.sourceKey === value.target.parentKey && r.kind === "boundary-open",
      )
    : undefined;
  if (value.target.parentKey && !parent?.closeKey)
    return c4NoChange(model, m.classPatchRejected());
  const padding = parent ? parent.indent + "  " : "  ";
  try {
    const next = insertC4Record(
      model,
      value.target,
      padding +
        c4CallSource(value.kind, [
          { key: "", value: alias },
          { key: "", value: value.label },
        ]),
    );
    return c4CommandResult(
      model,
      next,
      next.model.elements.find((e) => e.alias === alias)!.resolution!
        .selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
/** The primary label edit addresses its actual field provider, not the last call by index. */
export function editC4ElementLabel(
  model: MermaidC4Model,
  selectionId: string,
  label: string,
): C4CommandResult {
  const element = model.elements.find(
    (e) => e.resolution?.selectionId === selectionId,
  );
  if (!element) return c4NoChange(model, m.classPatchRejected());
  if (element.label === label) return c4NoChange(model);
  const provider = element.resolution!.providers.label;
  return writeC4LabelArgument(
    model,
    provider.sourceKey,
    provider.argumentIndex ?? 1,
    label,
    selectionId,
  );
}
/** An explicit earlier-record edit retains its position and shadowing/effective fields. */
export function editC4ElementRecordLabel(
  model: MermaidC4Model,
  sourceKey: string,
  label: string,
): C4CommandResult {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey && r.kind === "element",
  );
  const element = model.elements.find((e) =>
    e.resolution?.sourceKeys.includes(sourceKey),
  );
  return record && element
    ? writeC4LabelArgument(
        model,
        sourceKey,
        1,
        label,
        element.resolution!.selectionId,
      )
    : c4NoChange(model, m.classPatchRejected());
}
function writeC4LabelArgument(
  model: MermaidC4Model,
  sourceKey: string,
  argumentIndex: number,
  label: string,
  selectionId: string,
): C4CommandResult {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey,
  );
  if (!record?.arguments || !record.callKind)
    return c4NoChange(model, m.classPatchRejected());
  if (record.arguments[argumentIndex]?.value === label)
    return c4NoChange(model);
  const args = record.arguments.map((a) => ({ ...a }));
  while (args.length <= argumentIndex) args.push({ key: "", value: "" });
  args[argumentIndex] = { ...args[argumentIndex], value: label };
  try {
    return c4CommandResult(
      model,
      writeC4Patches(model, [
        c4CallPatch(model, sourceKey, record.callKind, args),
      ]),
      selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
export function c4ElementDeclarations(
  model: MermaidC4Model,
  selectionId: string,
) {
  const keys =
    model.elements.find((e) => e.resolution?.selectionId === selectionId)
      ?.resolution?.sourceKeys ?? [];
  return model.sourceDocument.records
    .filter((r) => keys.includes(r.sourceKey))
    .map((record) => ({
      record,
      occurrence: model.occurrences.find(
        (o) => o.sourceKey === record.sourceKey,
      )!,
    }));
}
