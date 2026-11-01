// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidErModel } from "../model.js";

import type { ErCardinality, MermaidErRelationship } from "../model.js";
import { erCardinalityToken } from "../parser.js";
import { nextErSourceKey } from "../source-document.js";
import {
  erNoChange,
  erRecord,
  erNewRecordPatch,
  sourceMermaidErEntityName,
  writeErPatches,
  type ErPatch,
  type ErWriteOptions,
} from "../writer.js";
import { erQuotedField, deleteErSelection } from "./entity-commands.js";
import { mermaidMessages as m } from "../../../i18n.js";
export type ErRelationshipChanges = Partial<
  Pick<
    MermaidErRelationship,
    "from" | "to" | "cardinalityA" | "cardinalityB" | "identification" | "label"
  >
>;
const verbalCardinalities: Record<ErCardinality, string> = {
  "exactly-one": "one",
  "zero-or-one": "zero or one",
  "one-or-many": "one or more",
  "zero-or-many": "zero or more",
  "mermaid-parent": "u",
};
function validRelationship(
  model: MermaidErModel,
  value: ErRelationshipChanges,
) {
  return (
    [value.from, value.to].every((id) =>
      [...model.entities, ...model.subgraphs].some((n) => n.id === id),
    ) &&
    [value.cardinalityA, value.cardinalityB].every(
      (c) => c !== undefined && Object.hasOwn(verbalCardinalities, c),
    ) &&
    Boolean(
      erCardinalityToken(value.cardinalityA!, "from") &&
      erCardinalityToken(value.cardinalityB!, "to"),
    ) &&
    ["--", ".."].includes(value.identification!) &&
    typeof value.label === "string" &&
    !/[\r\n]/.test(value.label!)
  );
}
export function addErRelationship(
  model: MermaidErModel,
  value: {
    from: string;
    to: string;
    cardinalityA: ErCardinality;
    cardinalityB: ErCardinality;
    identification: "--" | "..";
    label: string;
    subgraphId?: string | null;
    sourceKey?: string;
  },
  options: ErWriteOptions = {},
) {
  if (!validRelationship(model, value))
    return erNoChange(model, "invalid", m.erPatchRejected());
  const parent = value.subgraphId
      ? model.subgraphs.find((g) => g.id === value.subgraphId)
      : null,
    opening = parent ? erRecord(model, parent.sourceKey) : null,
    close = opening?.closeKey ? erRecord(model, opening.closeKey) : null;
  if (value.subgraphId && !close)
    return erNoChange(model, "invalid", m.erMissingObject());
  const key =
      value.sourceKey && !erRecord(model, value.sourceKey)
        ? value.sourceKey
        : nextErSourceKey(),
    label = sourceMermaidErEntityName(value.label),
    text = `${opening ? opening.indent + "  " : ""}${sourceMermaidErEntityName(value.from)} ${erCardinalityToken(value.cardinalityA, "from")}${value.identification}${erCardinalityToken(value.cardinalityB, "to")} ${sourceMermaidErEntityName(value.to)} : ${label}`;
  return writeErPatches(
    model,
    [
      erNewRecordPatch(
        model,
        close?.range.start ?? model.sourceDocument.source.length,
        text,
        key,
      ),
    ],
    { ...options, selection: key, focus: key },
  );
}
/** Endpoints and end cardinalities are separate edits. A reconnect cannot swap
 * markers; untouched verbal lexemes retain their exact original source form. */
export function editErRelationship(
  model: MermaidErModel,
  key: string,
  changes: ErRelationshipChanges,
  options: ErWriteOptions = {},
) {
  const relation = model.relationships.find((r) => r.id === key),
    record = erRecord(model, key);
  if (!relation || !record)
    return erNoChange(model, "invalid", m.erMissingObject());
  const next = { ...relation, ...changes };
  if (!validRelationship(model, next))
    return erNoChange(model, "invalid", m.erPatchRejected());
  const patches: ErPatch[] = [],
    source = model.sourceDocument.source;
  for (const field of [
    "from",
    "to",
    "cardinalityA",
    "cardinalityB",
    "identification",
    "label",
  ] as const) {
    if (!Object.hasOwn(changes, field) || next[field] === relation[field])
      continue;
    const lexical =
        field === "cardinalityA"
          ? "fromCardinality"
          : field === "cardinalityB"
            ? "toCardinality"
            : field,
      range = record.values[lexical];
    if (!range) return erNoChange(model, "invalid", m.erPatchRejected());
    const previous = source.slice(range.start, range.end);
    let value: string;
    if (field === "cardinalityA" || field === "cardinalityB") {
      const side = field === "cardinalityA" ? "from" : "to",
        cardinality = next[field];
      value = /^(?:\|\||o\||\|o|\}\||\}o|\|\{|o\{|u)$/.test(previous)
        ? erCardinalityToken(cardinality, side)
        : verbalCardinalities[cardinality];
      // Parent has no verbal phrase in the pinned grammar. Switch only this
      // relation's cardinality/line lexemes to the equivalent symbolic form.
      if (cardinality === "mermaid-parent" && !/^[|o{}u]+$/.test(previous)) {
        return editErRelationshipSymbolically(model, relation, next, options);
      }
    } else if (field === "identification")
      value = /^(?:--|\.\.|\.-|-\.)$/.test(previous)
        ? next.identification
        : next.identification === "--"
          ? "to"
          : "optionally to";
    else value = erQuotedField(source, range, next[field]);
    patches.push({ range, value });
  }
  return writeErPatches(model, patches, {
    ...options,
    selection: key,
    focus: key,
  });
}
function editErRelationshipSymbolically(
  model: MermaidErModel,
  previous: MermaidErRelationship,
  next: MermaidErRelationship,
  options: ErWriteOptions,
) {
  const record = erRecord(model, previous.id)!;
  const patches: ErPatch[] = [];
  for (const [field, value] of [
    ["from", sourceMermaidErEntityName(next.from)],
    ["to", sourceMermaidErEntityName(next.to)],
    ["fromCardinality", erCardinalityToken(next.cardinalityA, "from")],
    ["toCardinality", erCardinalityToken(next.cardinalityB, "to")],
    ["identification", next.identification],
    ["label", sourceMermaidErEntityName(next.label)],
  ] as const) {
    const range = record.values[field];
    if (!range) return erNoChange(model, "invalid", m.erPatchRejected());
    patches.push({ range, value });
  }
  return writeErPatches(model, patches, {
    ...options,
    selection: previous.id,
    focus: previous.id,
  });
}
export function reconnectErRelationship(
  model: MermaidErModel,
  key: string,
  endpoint: "from" | "to",
  entityId: string,
  options: ErWriteOptions = {},
) {
  return editErRelationship(model, key, { [endpoint]: entityId }, options);
}
export function reverseErRelationship(
  model: MermaidErModel,
  key: string,
  options: ErWriteOptions = {},
) {
  const relation = model.relationships.find((r) => r.id === key);
  if (!relation) return erNoChange(model, "invalid", m.erMissingObject());
  return editErRelationship(
    model,
    key,
    {
      from: relation.to,
      to: relation.from,
      cardinalityA: relation.cardinalityB,
      cardinalityB: relation.cardinalityA,
    },
    options,
  );
}
export function deleteErRelationship(
  model: MermaidErModel,
  key: string,
  options: ErWriteOptions = {},
) {
  return deleteErSelection(model, [key], options);
}
