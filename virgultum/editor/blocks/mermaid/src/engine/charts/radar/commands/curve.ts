// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommandContext,
  MermaidRadarCurveCommand,
} from "./types.js";
import {
  encodeRadarLabel,
  RADAR_ID_PATTERN,
  validRadarValue,
} from "./types.js";
import {
  mermaidRadarNumber,
  radarCurveSource,
  radarInsertionPatch,
  radarNoChange,
  radarOwnedRecordRange,
  radarPatchedResult,
  radarRecord,
  radarRecordRemovalPatch,
  radarRemovalRange,
} from "../writer.js";

function curveSelection(
  result: ReturnType<typeof radarPatchedResult>,
  name: string,
) {
  const curve = result.model.curves.find(
    (candidate) => candidate.name === name,
  );
  return curve && result.changed
    ? { ...result, selectionAfter: { id: curve.id, kind: "curve" as const } }
    : result;
}

function addCurve(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCurveCommand, { type: "curve.add" }>,
) {
  const { model, source } = context;
  const name = command.name.trim();
  const label = command.label.trim();
  if (
    model.axes.length === 0 ||
    !RADAR_ID_PATTERN.test(name) ||
    model.curves.some((curve) => curve.name === name) ||
    model.axes.some((axis) => !validRadarValue(command.values[axis.id]))
  )
    return radarNoChange(model, source, "radar.curve-invalid");
  const entries = model.axes.map((axis) =>
    command.form === "detailed"
      ? `${axis.name}: ${mermaidRadarNumber(command.values[axis.id])}`
      : mermaidRadarNumber(command.values[axis.id]),
  );
  const named = label ? `${name}[${encodeRadarLabel(label)}]` : name;
  const patch = radarInsertionPatch(
    model,
    `  curve ${named} {${entries.join(", ")}}`,
    ["header", "metadata", "axis", "curve"],
  );
  return curveSelection(
    radarPatchedResult({
      model,
      patches: [patch],
      selectionAfter: null,
      source,
    }),
    name,
  );
}

function labelCurve(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCurveCommand, { type: "curve.label" }>,
) {
  const curve = context.model.curves.find(
    (candidate) => candidate.id === command.curveId,
  );
  const sourceInfo = curve ? radarCurveSource(context.model, curve) : null;
  if (!curve || !sourceInfo)
    return radarNoChange(context.model, context.source, "radar.curve-missing");
  const label = command.label.trim();
  const patch = sourceInfo.item.labelRange
    ? label
      ? {
          range: sourceInfo.item.labelRange,
          value: encodeRadarLabel(label, curve.labelQuote).slice(1, -1),
        }
      : {
          range: {
            end:
              context.source.indexOf("]", sourceInfo.item.labelRange.end) + 1,
            start: context.source.lastIndexOf(
              "[",
              sourceInfo.item.labelRange.start - 2,
            ),
          },
          value: "",
        }
    : label
      ? {
          range: {
            end: sourceInfo.item.nameRange.end,
            start: sourceInfo.item.nameRange.end,
          },
          value: `[${encodeRadarLabel(label, curve.labelQuote)}]`,
        }
      : null;
  if (
    !patch ||
    patch.range.start < sourceInfo.item.nameRange.end ||
    patch.range.end > sourceInfo.item.range.end
  )
    return radarNoChange(
      context.model,
      context.source,
      label === (curve.labelExplicit ? curve.label : "")
        ? "radar.no-change"
        : "radar.patch-unavailable",
    );
  return radarPatchedResult({
    model: context.model,
    patches: [patch],
    selectionAfter: { id: curve.id, kind: "curve" },
    source: context.source,
  });
}

function renameCurve(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCurveCommand, { type: "curve.name" }>,
) {
  const { model, source } = context;
  const curve = model.curves.find(
    (candidate) => candidate.id === command.curveId,
  );
  const sourceInfo = curve ? radarCurveSource(model, curve) : null;
  const name = command.name.trim();
  if (
    !curve ||
    !sourceInfo ||
    !RADAR_ID_PATTERN.test(name) ||
    model.curves.some(
      (candidate) => candidate.id !== curve.id && candidate.name === name,
    )
  )
    return radarNoChange(model, source, "radar.curve-invalid");
  return curveSelection(
    radarPatchedResult({
      model,
      patches: [{ range: sourceInfo.item.nameRange, value: name }],
      selectionAfter: null,
      source,
    }),
    name,
  );
}

function reorderCurve(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCurveCommand, { type: "curve.reorder" }>,
) {
  const { model, source } = context;
  const curveSources = model.curves.map((curve) =>
    radarCurveSource(model, curve),
  );
  if (curveSources.some((sourceInfo) => !sourceInfo?.record.valid))
    return radarNoChange(model, source, "radar.curve-impact-unresolved");
  const from = model.curves.findIndex((curve) => curve.id === command.curveId);
  if (from < 0) return radarNoChange(model, source, "radar.curve-missing");
  const without = model.curves.filter((curve) => curve.id !== command.curveId);
  const to = command.beforeCurveId
    ? without.findIndex((curve) => curve.id === command.beforeCurveId)
    : without.length;
  if (to < 0) return radarNoChange(model, source, "radar.curve-missing");
  const ordered = [
    ...without.slice(0, to),
    model.curves[from],
    ...without.slice(to),
  ];
  if (ordered.every((curve, index) => curve.id === model.curves[index]?.id))
    return radarNoChange(model, source, "radar.no-change");
  const raw = new Map(
    model.curves.map((curve) => {
      const info = radarCurveSource(model, curve)!;
      return [
        curve.id,
        source.slice(info.item.range.start, info.item.range.end),
      ] as const;
    }),
  );
  const resolvedCurveSources = curveSources.filter(
    (sourceInfo): sourceInfo is NonNullable<typeof sourceInfo> =>
      Boolean(sourceInfo),
  );
  const recordsAreIndividual =
    new Set(resolvedCurveSources.map((item) => item.record.id)).size ===
      model.curves.length &&
    resolvedCurveSources.every((item) => item.record.curves.length === 1);
  const hasAnchoredComments = model.comments.some(
    (comment) => comment.anchor.kind === "curve",
  );
  if (hasAnchoredComments && !recordsAreIndividual)
    return radarNoChange(model, source, "radar.curve-comments-ambiguous");
  const patches = recordsAreIndividual
    ? model.curves.map((slot, index) => {
        const sourceInfo = radarCurveSource(model, slot)!;
        const sourceOwner = ordered[index];
        const ownerInfo = radarCurveSource(model, sourceOwner)!;
        const range = radarOwnedRecordRange(model, sourceInfo.record, {
          id: slot.id,
          kind: "curve",
        });
        const ownerRange = radarOwnedRecordRange(model, ownerInfo.record, {
          id: sourceOwner.id,
          kind: "curve",
        });
        return {
          range,
          value: source.slice(ownerRange.start, ownerRange.end),
        };
      })
    : model.curves.map((slot, index) => ({
        range: radarCurveSource(model, slot)!.item.range,
        value: raw.get(ordered[index].id)!,
      }));
  return radarPatchedResult({
    model,
    patches,
    selectionAfter: { id: command.curveId, kind: "curve" },
    source,
  });
}

function deleteCurve(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCurveCommand, { type: "curve.delete" }>,
) {
  const { model, source } = context;
  const curve = model.curves.find(
    (candidate) => candidate.id === command.curveId,
  );
  const sourceInfo = curve ? radarCurveSource(model, curve) : null;
  if (!curve || !sourceInfo)
    return radarNoChange(model, source, "radar.curve-missing");
  if (!sourceInfo.record.valid)
    return radarNoChange(model, source, "radar.curve-impact-unresolved");
  const siblings = sourceInfo.record.curves;
  const ownedRange =
    siblings.length === 1
      ? radarOwnedRecordRange(model, sourceInfo.record, {
          id: curve.id,
          kind: "curve",
        })
      : null;
  const fallback = model.curves.filter(
    (candidate) => candidate.id !== curve.id,
  )[Math.min(curve.order, model.curves.length - 2)];
  const commentPatches = model.comments.flatMap((comment) => {
    if (comment.anchor.kind !== "curve" || comment.anchor.id !== curve.id)
      return [];
    const record = radarRecord(model, comment.sourceRecordId);
    return record?.kind === "comment" &&
      (!ownedRange ||
        record.range.start < ownedRange.start ||
        record.range.end > ownedRange.end)
      ? [radarRecordRemovalPatch(model, record)]
      : [];
  });
  return radarPatchedResult({
    model,
    patches: [
      ownedRange
        ? radarRecordRemovalPatch(model, { range: ownedRange })
        : {
            range: radarRemovalRange(
              sourceInfo.record,
              sourceInfo.item,
              siblings,
            ),
            value: "",
          },
      ...commentPatches,
    ],
    selectionAfter: fallback
      ? { id: fallback.id, kind: "curve" }
      : { kind: "diagram" },
    source,
  });
}

function convertCurve(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarCurveCommand, { type: "curve.form" }>,
) {
  const { model, source } = context;
  const curve = model.curves.find(
    (candidate) => candidate.id === command.curveId,
  );
  if (!curve || curve.sourceForm === command.form)
    return radarNoChange(
      model,
      source,
      curve ? "radar.no-change" : "radar.curve-missing",
    );
  if (
    curve.vertices.some(
      (vertex) => vertex.state === "missing" || vertex.state === "duplicate",
    ) ||
    curve.entries.some(
      (entry) => entry.status === "unknown" || entry.status === "extra",
    )
  )
    return radarNoChange(model, source, "radar.form-conversion-incomplete");
  const byAxis = new Map(
    curve.vertices.map((vertex) => [vertex.axisId, vertex.value!]),
  );
  const entries = model.axes.map((axis) =>
    command.form === "detailed"
      ? `${axis.name}${curve.entries[0]?.colon ? ":" : ""} ${mermaidRadarNumber(byAxis.get(axis.id)!)} `
      : mermaidRadarNumber(byAxis.get(axis.id)!),
  );
  const info = radarCurveSource(model, curve);
  if (!info) return radarNoChange(model, source, "radar.patch-unavailable");
  const raw = source.slice(info.item.range.start, info.item.range.end);
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open < 0 || close <= open)
    return radarNoChange(model, source, "radar.patch-unavailable");
  return radarPatchedResult({
    model,
    patches: [
      {
        range: {
          end: info.item.range.start + close,
          start: info.item.range.start + open + 1,
        },
        value: entries.map((entry) => entry.trim()).join(", "),
      },
    ],
    selectionAfter: { id: curve.id, kind: "curve" },
    source,
  });
}

export function applyMermaidRadarCurveCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarCurveCommand;
  if (command.type === "curve.add") return addCurve(context, command);
  if (command.type === "curve.label") return labelCurve(context, command);
  if (command.type === "curve.name") return renameCurve(context, command);
  if (command.type === "curve.reorder") return reorderCurve(context, command);
  if (command.type === "curve.delete") return deleteCurve(context, command);
  if (command.type === "curve.form") return convertCurve(context, command);
  return radarNoChange(context.model, context.source, "radar.command-invalid");
}
