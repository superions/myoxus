// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateModel } from "../model.js";
import { nextStateSourceKey } from "../source-document.js";
import { mermaidMessages as m } from "../../../i18n.js";
import { stateObject, deleteState, renameStateId } from "./state-commands.js";
import {
  addStateTransition,
  deleteStateTransition,
} from "./transition-commands.js";
import {
  stateNoChange,
  stateRecord,
  stateRecordEnd,
  stateInsertAnchor,
  stateNewRecordPatch,
  stateSourceIdValue,
  stateImpact,
  writeStatePatches,
  composeStateCommandResults,
  type StateInsertAnchor,
  type StateWriteOptions,
  type StatePatch,
} from "../writer.js";

export type NamedStateNotation = "choice" | "fork" | "join";
export function addStatePseudostate(
  model: MermaidStateModel,
  value: { id: string; kind: NamedStateNotation; anchor?: StateInsertAnchor },
  options: StateWriteOptions = {},
) {
  const at = stateInsertAnchor(model, value.anchor),
    key = nextStateSourceKey();
  if (
    !at ||
    !stateSourceIdValue(value.id, "pseudostate") ||
    stateObject(model, value.id) ||
    !["choice", "fork", "join"].includes(value.kind)
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return writeStatePatches(
    model,
    [
      stateNewRecordPatch(
        model,
        at.offset,
        `${at.indent}state ${value.id} <<${value.kind}>>`,
        key,
      ),
    ],
    { ...options, selection: value.id, focus: value.id },
  );
}
export function convertStatePseudostate(
  model: MermaidStateModel,
  key: string,
  kind: NamedStateNotation | "state",
  options: StateWriteOptions = {},
) {
  const node = model.states.find((n) => n.id === key || n.sourceKey === key);
  if (
    !node ||
    node.kind === "start" ||
    node.kind === "end" ||
    !["choice", "fork", "join", "state"].includes(kind)
  )
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (node.kind === kind) return writeStatePatches(model, [], options);
  const records = (node.recordKeys ?? [])
    .map((k) => stateRecord(model, k)!)
    .filter(Boolean);
  const declaration = records.find(
    (r) => r.kind === "pseudostate" || r.kind === "state",
  );
  const patches: StatePatch[] = [];
  // A conversion explicitly removes incompatible descriptions; its impact is
  // returned to the shared confirmation consumer before any document write.
  const removed = new Set<string>();
  const retainedClasses = new Set<string>();
  for (const r of records) {
    if (r === declaration || r.kind === "pseudostate") {
      patches.push({
        range: { start: r.range.start + r.indent.length, end: r.range.end },
        value: kind === "state" ? node.id : `state ${node.id} <<${kind}>>`,
      });
      if (r.values.classes)
        retainedClasses.add(
          model.sourceDocument.source.slice(
            r.values.classes.start,
            r.values.classes.end,
          ),
        );
    } else if (kind !== "state" && r.kind === "description") {
      removed.add(r.sourceKey);
      patches.push({
        range: { start: r.range.start, end: stateRecordEnd(r) },
        value: "",
      });
    }
  }
  if (retainedClasses.size && declaration)
    patches.push(
      stateNewRecordPatch(
        model,
        stateRecordEnd(declaration),
        `${declaration.indent}class ${node.id} ${[...retainedClasses].join(",")}`,
      ),
    );
  if (!declaration) {
    const at = stateInsertAnchor(model, {
      parentId: node.parentId,
      regionKey: node.regionKey,
    });
    if (!at) return stateNoChange(model, "invalid", m.classPatchRejected());
    patches.push(
      stateNewRecordPatch(
        model,
        at.offset,
        at.indent +
          (kind === "state" ? node.id : `state ${node.id} <<${kind}>>`),
      ),
    );
  }
  return writeStatePatches(model, patches, {
    ...options,
    removed,
    commentTransfers: new Set(
      model.commentRecords
        .filter(
          (c) =>
            c.anchorId &&
            [...removed].some(
              (key) => c.anchorId === key || c.anchorId!.startsWith(key + ":"),
            ),
        )
        .map((c) => c.id),
    ),
    impact: stateImpact(model, records),
    selection: node.sourceKey,
    focus: node.sourceKey,
  });
}
/** ID and notation changes are validated together and commit one Source patch. */
export function editStateNotation(
  model: MermaidStateModel,
  key: string,
  value: { id: string; kind: NamedStateNotation | "state" },
  options: StateWriteOptions = {},
) {
  const renamed = renameStateId(model, key, value.id, options);
  if (renamed.status === "rejected") return renamed;
  const converted = convertStatePseudostate(renamed.model, key, value.kind, {
    ...options,
    baseSource: renamed.source,
  });
  return converted.status === "rejected"
    ? stateNoChange(model, converted.reason, converted.diagnostic)
    : composeStateCommandResults(model, converted, options);
}
/** Start/end have no standalone declaration: creation always owns a relation. */
export function addStateTerminal(
  model: MermaidStateModel,
  value: {
    kind: "start" | "end";
    target: string;
    label?: string;
    anchor?: StateInsertAnchor;
  },
  options: StateWriteOptions = {},
) {
  if (!stateObject(model, value.target))
    return stateNoChange(model, "invalid", m.stateMissingObject());
  return addStateTransition(
    model,
    {
      from: value.kind === "start" ? "[*]" : value.target,
      to: value.kind === "end" ? "[*]" : value.target,
      label: value.label,
      anchor: value.anchor,
    },
    options,
  );
}
export function deleteStatePseudostate(
  model: MermaidStateModel,
  key: string,
  relationKeys: readonly string[] | "all",
  options: StateWriteOptions = {},
) {
  const node = model.states.find((n) => n.id === key || n.sourceKey === key);
  if (!node) return stateNoChange(model, "invalid", m.stateMissingObject());
  if (node.kind !== "start" && node.kind !== "end")
    return deleteState(model, key, options);
  const bound = node.relationKeys ?? [],
    selected = relationKeys === "all" ? bound : relationKeys;
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((k) => !bound.includes(k))
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  let next = model;
  let result = writeStatePatches(model, [], options);
  for (const k of selected) {
    result = deleteStateTransition(next, k, {
      ...options,
      baseSource: next.sourceDocument.source,
    });
    if (result.status === "rejected") return result;
    next = result.model;
  }
  return composeStateCommandResults(
    model,
    {
      ...result,
      impact: stateImpact(
        model,
        selected.map((k) => stateRecord(model, k)!),
      ),
    },
    options,
  );
}
