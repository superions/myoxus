// SPDX-License-Identifier: AGPL-3.0-or-later

import { classRelationSemantics } from "../parser.js";
import { nextClassSourceKey } from "../source-document.js";
import type { MermaidClassModel } from "../model.js";

import type { ClassMarker, MermaidClassRelation } from "../model.js";
import { sourceMermaidClassName } from "../source-document.js";
import { validClassId } from "./class-commands.js";
import {
  classNoChange,
  classRecord,
  classRecordGroup,
  classNewRecordPatch,
  writeClassPatches,
  type ClassPatch,
  type ClassWriteOptions,
} from "../writer.js";
import { mermaidMessages as messages } from "../../../i18n.js";
export const CLASS_RELATION_PRESETS = {
  association: "--",
  directed: "-->",
  inheritance: "--|>",
  realization: "..|>",
  dependency: "..>",
  aggregation: "o--",
  composition: "*--",
  lollipop: "--()",
} as const;
export function classRelationToken(
  from: ClassMarker,
  line: MermaidClassRelation["lineStyle"],
  to: ClassMarker,
) {
  const start = {
    none: "",
    arrow: "<",
    inheritance: "<|",
    aggregation: "o",
    composition: "*",
    lollipop: "()",
  }[from];
  const end = {
    none: "",
    arrow: ">",
    inheritance: "|>",
    aggregation: "o",
    composition: "*",
    lollipop: "()",
  }[to];
  return start + (line === "dashed" ? ".." : "--") + end;
}
export type ClassRelationChanges = Partial<
  Pick<
    MermaidClassRelation,
    | "fromSourceId"
    | "toSourceId"
    | "fromMarker"
    | "toMarker"
    | "lineStyle"
    | "fromCardinality"
    | "toCardinality"
    | "label"
  >
> & { preset?: keyof typeof CLASS_RELATION_PRESETS; reverse?: boolean };
function relationText(
  value: Partial<MermaidClassRelation> &
    Pick<MermaidClassRelation, "fromSourceId" | "toSourceId">,
) {
  return `${sourceMermaidClassName(value.fromSourceId)}${value.fromCardinality ? ` "${value.fromCardinality}"` : ""} ${value.kind ?? "-->"} ${value.toCardinality ? `"${value.toCardinality}" ` : ""}${sourceMermaidClassName(value.toSourceId)}${value.label ? ` : ${value.label}` : ""}`;
}
export function connectClasses(
  model: MermaidClassModel,
  value: {
    fromSourceId: string;
    toSourceId: string;
    sourceKey?: string;
    kind?: string;
    fromMarker?: ClassMarker;
    toMarker?: ClassMarker;
    lineStyle?: MermaidClassRelation["lineStyle"];
    fromCardinality?: string;
    toCardinality?: string;
    label?: string;
  },
  options: ClassWriteOptions = {},
) {
  const key =
    value.sourceKey && !classRecord(model, value.sourceKey)
      ? value.sourceKey
      : nextClassSourceKey();
  if (
    [value.fromCardinality, value.toCardinality].some((card) =>
      /["\r\n]/.test(card ?? ""),
    ) ||
    /[;:\r\n]/.test(value.label ?? "")
  )
    return classNoChange(model, "invalid", messages.classPatchRejected());
  const kind =
    value.kind ??
    classRelationToken(
      value.fromMarker ?? "none",
      value.lineStyle ?? "solid",
      value.toMarker ?? "none",
    );
  const semantics = classRelationSemantics(kind);
  const interfaceEnd = (side: "from" | "to") =>
    side === "from"
      ? semantics.fromMarker === "lollipop" && semantics.toMarker === "none"
      : semantics.toMarker === "lollipop" && semantics.fromMarker === "none";
  if (
    ["from", "to"].some((side) => {
      const end = side === "from" ? "fromSourceId" : "toSourceId";
      return (
        !validClassId(value[end]) ||
        (!interfaceEnd(side as "from" | "to") &&
          !model.nodes.some(
            (n) => n.kind === "class" && n.sourceId === value[end],
          ))
      );
    })
  )
    return classNoChange(model, "invalid", messages.classMissingObject());
  return writeClassPatches(
    model,
    [
      classNewRecordPatch(
        model,
        model.sourceDocument.source.length,
        relationText({ ...value, kind }),
        key,
      ),
    ],
    { ...options, selection: key },
  );
}
export function editClassRelation(
  model: MermaidClassModel,
  key: string,
  changes: ClassRelationChanges,
  options: ClassWriteOptions = {},
) {
  const relation = model.relations.find((r) => r.id === key),
    record = classRecord(model, key);
  if (!relation || !record)
    return classNoChange(model, "invalid", messages.classMissingObject());
  const next = {
    ...relation,
    ...(changes.preset
      ? classRelationSemantics(CLASS_RELATION_PRESETS[changes.preset])
      : {}),
    ...changes,
  };
  if (changes.reverse) {
    [next.fromSourceId, next.toSourceId] = [next.toSourceId, next.fromSourceId];
    [next.fromCardinality, next.toCardinality] = [
      next.toCardinality,
      next.fromCardinality,
    ];
    [next.fromMarker, next.toMarker] = [next.toMarker, next.fromMarker];
  }
  next.kind = classRelationToken(
    next.fromMarker,
    next.lineStyle,
    next.toMarker,
  );
  const patches: ClassPatch[] = [];
  for (const side of ["from", "to"] as const) {
    const field = side === "from" ? "fromSourceId" : "toSourceId",
      marker = side === "from" ? next.fromMarker : next.toMarker;
    if (next[field] !== relation[field]) {
      if (!validClassId(next[field]))
        return classNoChange(model, "invalid", messages.classIdInvalid());
      if (
        !(
          marker === "lollipop" &&
          (side === "from" ? next.toMarker : next.fromMarker) === "none"
        ) &&
        !model.nodes.some(
          (n) => n.kind === "class" && n.sourceId === next[field],
        )
      )
        return classNoChange(model, "invalid", messages.classMissingObject());
      patches.push({
        range: record.values[side]!,
        value: sourceMermaidClassName(next[field]),
      });
    }
    const card = side === "from" ? "fromCardinality" : "toCardinality",
      range = record.values[card];
    if (next[card] === relation[card]) continue;
    if (/["\r\n]/.test(next[card]))
      return classNoChange(model, "invalid", messages.classPatchRejected());
    if (range) patches.push({ range, value: next[card] });
    else {
      const end =
        side === "from" ? record.values.from!.end : record.values.to!.start;
      patches.push({
        range: { start: end, end },
        value: side === "from" ? ` "${next[card]}"` : `"${next[card]}" `,
      });
    }
  }
  if (next.kind !== relation.kind)
    patches.push({ range: record.values.kind!, value: next.kind });
  if (next.label !== relation.label) {
    if (/[;:\r\n]/.test(next.label))
      return classNoChange(model, "invalid", messages.classPatchRejected());
    const range = record.values.label;
    if (range) {
      if (next.label) patches.push({ range, value: next.label });
      else {
        const start = model.sourceDocument.source.lastIndexOf(":", range.start);
        patches.push({ range: { start, end: range.end }, value: "" });
      }
    } else {
      const end =
        record.range.end - (record.raw.trimEnd().endsWith(";") ? 1 : 0);
      patches.push({
        range: { start: end, end },
        value: next.label ? ` : ${next.label}` : "",
      });
    }
  }
  return writeClassPatches(model, patches, { ...options, selection: key });
}
export function deleteClassRelation(
  model: MermaidClassModel,
  key: string,
  options: ClassWriteOptions = {},
) {
  const group = classRecordGroup(model, key);
  if (!group)
    return classNoChange(model, "invalid", messages.classMissingObject());
  return writeClassPatches(model, [{ range: group.range, value: "" }], {
    ...options,
    removed: new Set(group.records.map((r) => r.sourceKey)),
    impact: {
      records: group.records.map((r) => ({
        id: r.sourceKey,
        kind: r.kind,
        label: r.raw.trim(),
      })),
      attachedNotes: [],
    },
  });
}
