// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarAxisCommand,
  MermaidRadarCommandContext,
} from "./types.js";
import {
  encodeRadarLabel,
  RADAR_ID_PATTERN,
  validRadarValue,
} from "./types.js";
import {
  mermaidRadarNumber,
  radarAxisSource,
  radarCurveSource,
  radarEntryAppendPatch,
  radarEntryRemovalRange,
  radarEntrySource,
  radarInsertionPatch,
  radarNoChange,
  radarOwnedRecordRange,
  radarPatchedResult,
  radarRecord,
  radarRecordRemovalPatch,
  radarRemovalRange,
  type MermaidRadarSourcePatch,
} from "../writer.js";

function axisSelection(
  result: ReturnType<typeof radarPatchedResult>,
  name: string,
) {
  const axis = result.model.axes.find((candidate) => candidate.name === name);
  return axis && result.changed
    ? { ...result, selectionAfter: { id: axis.id, kind: "axis" as const } }
    : result;
}

function addAxis(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarAxisCommand, { type: "axis.add" }>,
) {
  const { model, source } = context;
  const name = command.name.trim();
  const label = command.label.trim();
  if (
    !RADAR_ID_PATTERN.test(name) ||
    model.axes.some((axis) => axis.name === name) ||
    model.curves.some(
      (curve) =>
        curve.sourceForm === "mixed" ||
        (curve.sourceForm === "positional" &&
          curve.entries.length !== model.axes.length),
    ) ||
    model.curves.some((curve) => !validRadarValue(command.values[curve.id]))
  )
    return radarNoChange(model, source, "radar.axis-invalid");
  const item = label ? `${name}[${encodeRadarLabel(label)}]` : name;
  // A new axis is its own source object. Appending it to an existing grouped
  // statement would make a comment anchored to that statement ambiguous.
  const axisPatch = radarInsertionPatch(model, `  axis ${item}`, [
    "header",
    "metadata",
    "axis",
  ]);
  const curvePatches = model.curves.map((curve) => {
    const addedEntry =
      curve.sourceForm === "detailed"
        ? `${name}${curve.entries[0]?.colon ? ":" : ""} ${mermaidRadarNumber(command.values[curve.id])}`
        : mermaidRadarNumber(command.values[curve.id]);
    return radarEntryAppendPatch(source, model, curve, addedEntry);
  });
  if (curvePatches.some((patch) => !patch))
    return radarNoChange(model, source, "radar.patch-unavailable");
  return axisSelection(
    radarPatchedResult({
      model,
      patches: [
        axisPatch,
        ...curvePatches.filter((patch): patch is MermaidRadarSourcePatch =>
          Boolean(patch),
        ),
      ],
      selectionAfter: null,
      source,
    }),
    name,
  );
}

function labelAxis(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarAxisCommand, { type: "axis.label" }>,
) {
  const axis = context.model.axes.find(
    (candidate) => candidate.id === command.axisId,
  );
  const sourceInfo = axis ? radarAxisSource(context.model, axis) : null;
  if (!axis || !sourceInfo)
    return radarNoChange(context.model, context.source, "radar.axis-missing");
  const label = command.label.trim();
  const patch = sourceInfo.item.labelRange
    ? label
      ? {
          range: sourceInfo.item.labelRange,
          value: encodeRadarLabel(label, axis.labelQuote).slice(1, -1),
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
          value: `[${encodeRadarLabel(label, axis.labelQuote)}]`,
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
      label === (axis.labelExplicit ? axis.label : "")
        ? "radar.no-change"
        : "radar.patch-unavailable",
    );
  return radarPatchedResult({
    model: context.model,
    patches: [patch],
    selectionAfter: { id: axis.id, kind: "axis" },
    source: context.source,
  });
}

function renameAxis(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarAxisCommand, { type: "axis.name" }>,
) {
  const { model, source } = context;
  const axis = model.axes.find((candidate) => candidate.id === command.axisId);
  const sourceInfo = axis ? radarAxisSource(model, axis) : null;
  const name = command.name.trim();
  if (
    !axis ||
    !sourceInfo ||
    !RADAR_ID_PATTERN.test(name) ||
    model.axes.some(
      (candidate) => candidate.id !== axis.id && candidate.name === name,
    ) ||
    (model.axes.filter((candidate) => candidate.name === axis.name).length >
      1 &&
      model.curves.some(
        (curve) =>
          curve.sourceForm === "detailed" &&
          curve.entries.some((entry) => entry.axisName === axis.name),
      ))
  )
    return radarNoChange(model, source, "radar.axis-invalid");
  const referencePatches = model.curves.flatMap((curve) => {
    if (curve.sourceForm !== "detailed") return [];
    const curveSource = radarCurveSource(model, curve);
    if (!curveSource) return [null];
    return curve.entries.flatMap((entry, index) => {
      if (entry.axisName !== axis.name) return [];
      const entrySource = curveSource.item.entries[index];
      return entrySource?.axisNameRange
        ? [{ range: entrySource.axisNameRange, value: name }]
        : [null];
    });
  });
  if (referencePatches.some((patch) => !patch))
    return radarNoChange(model, source, "radar.patch-unavailable");
  const resolvedReferencePatches = referencePatches.filter(
    (patch) => patch !== null,
  );
  return axisSelection(
    radarPatchedResult({
      model,
      patches: [
        { range: sourceInfo.item.nameRange, value: name },
        ...resolvedReferencePatches,
      ],
      selectionAfter: null,
      source,
    }),
    name,
  );
}

function reorderAxis(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarAxisCommand, { type: "axis.reorder" }>,
) {
  const { model, source } = context;
  const axisSources = model.axes.map((axis) => radarAxisSource(model, axis));
  if (
    axisSources.some((sourceInfo) => !sourceInfo?.record.valid) ||
    model.curves.some(
      (curve) =>
        curve.sourceForm === "mixed" ||
        (curve.sourceForm === "positional" &&
          curve.entries.length !== model.axes.length) ||
        (curve.sourceForm === "detailed" &&
          curve.vertices.some(
            (vertex) =>
              vertex.state === "missing" || vertex.state === "duplicate",
          )),
    )
  )
    return radarNoChange(model, source, "radar.axis-impact-unresolved");
  const from = model.axes.findIndex((axis) => axis.id === command.axisId);
  if (from < 0) return radarNoChange(model, source, "radar.axis-missing");
  const without = model.axes.filter((axis) => axis.id !== command.axisId);
  const to = command.beforeAxisId
    ? without.findIndex((axis) => axis.id === command.beforeAxisId)
    : without.length;
  if (to < 0) return radarNoChange(model, source, "radar.axis-missing");
  const ordered = [
    ...without.slice(0, to),
    model.axes[from],
    ...without.slice(to),
  ];
  if (ordered.every((axis, index) => axis.id === model.axes[index]?.id))
    return radarNoChange(model, source, "radar.no-change");
  const resolvedAxisSources = axisSources.filter(
    (sourceInfo): sourceInfo is NonNullable<typeof sourceInfo> =>
      Boolean(sourceInfo),
  );
  const rawItems = new Map(
    model.axes.map((axis) => {
      const info = radarAxisSource(model, axis)!;
      return [
        axis.id,
        source.slice(info.item.range.start, info.item.range.end),
      ] as const;
    }),
  );
  const recordsAreIndividual =
    new Set(resolvedAxisSources.map((item) => item.record.id)).size ===
      model.axes.length &&
    resolvedAxisSources.every((item) => item.record.axes.length === 1);
  const hasAnchoredComments = model.comments.some(
    (comment) => comment.anchor.kind === "axis",
  );
  if (hasAnchoredComments && !recordsAreIndividual)
    return radarNoChange(model, source, "radar.axis-comments-ambiguous");
  const axisPatches: MermaidRadarSourcePatch[] = recordsAreIndividual
    ? model.axes.map((slot, index) => {
        const sourceInfo = radarAxisSource(model, slot)!;
        const sourceOwner = ordered[index];
        const ownerInfo = radarAxisSource(model, sourceOwner)!;
        const range = radarOwnedRecordRange(model, sourceInfo.record, {
          id: slot.id,
          kind: "axis",
        });
        const ownerRange = radarOwnedRecordRange(model, ownerInfo.record, {
          id: sourceOwner.id,
          kind: "axis",
        });
        return {
          range,
          value: source.slice(ownerRange.start, ownerRange.end),
        };
      })
    : model.axes.map((slot, index) => ({
        range: radarAxisSource(model, slot)!.item.range,
        value: rawItems.get(ordered[index].id)!,
      }));
  const curvePatches = model.curves
    .filter((candidate) => candidate.sourceForm === "positional")
    .flatMap((curve) => {
      const byAxis = new Map(
        model.axes.map((axis, index) => [axis.id, curve.entries[index]]),
      );
      const raw = new Map(
        model.axes.map((axis) => {
          const entry = byAxis.get(axis.id)!;
          const info = radarEntrySource(model, entry)!;
          return [
            axis.id,
            source.slice(info.entry.range.start, info.entry.range.end),
          ] as const;
        }),
      );
      return curve.entries.map((slot, index) => {
        const info = radarEntrySource(model, slot)!;
        return {
          range: info.entry.range,
          value: raw.get(ordered[index].id)!,
        } satisfies MermaidRadarSourcePatch;
      });
    });
  return radarPatchedResult({
    model,
    patches: [...axisPatches, ...curvePatches],
    selectionAfter: { id: command.axisId, kind: "axis" },
    source,
  });
}

function deleteAxis(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarAxisCommand, { type: "axis.delete" }>,
) {
  const { model, source } = context;
  const axis = model.axes.find((candidate) => candidate.id === command.axisId);
  const sourceInfo = axis ? radarAxisSource(model, axis) : null;
  if (!axis || !sourceInfo)
    return radarNoChange(model, source, "radar.axis-missing");
  if (!sourceInfo.record.valid)
    return radarNoChange(model, source, "radar.axis-impact-unresolved");
  if (
    model.axes.filter((candidate) => candidate.name === axis.name).length > 1 &&
    model.curves.some(
      (curve) =>
        curve.sourceForm === "detailed" &&
        curve.entries.some((entry) => entry.axisName === axis.name),
    )
  )
    return radarNoChange(model, source, "radar.axis-impact-unresolved");
  if (
    model.curves.some(
      (curve) =>
        curve.sourceForm === "mixed" ||
        (curve.sourceForm === "positional" &&
          curve.entries.length !== model.axes.length) ||
        (curve.sourceForm === "detailed" &&
          curve.entries.filter((entry) => entry.axisName === axis.name)
            .length !== 1),
    )
  )
    return radarNoChange(model, source, "radar.axis-impact-unresolved");
  const ownedRange =
    sourceInfo.record.axes.length === 1
      ? radarOwnedRecordRange(model, sourceInfo.record, {
          id: axis.id,
          kind: "axis",
        })
      : null;
  const axisPatch: MermaidRadarSourcePatch = ownedRange
    ? radarRecordRemovalPatch(model, { range: ownedRange })
    : {
        range: radarRemovalRange(
          sourceInfo.record,
          sourceInfo.item,
          sourceInfo.record.axes,
        ),
        value: "",
      };
  const curvePatches = model.curves.map((curve) => {
    const entry =
      curve.sourceForm === "detailed"
        ? curve.entries.find((candidate) => candidate.axisName === axis.name)
        : curve.entries[axis.order];
    const info = entry ? radarEntrySource(model, entry) : null;
    return info
      ? ({
          range: radarEntryRemovalRange(
            info.record,
            info.entry,
            info.curveSource.entries,
          ),
          value: "",
        } satisfies MermaidRadarSourcePatch)
      : null;
  });
  if (curvePatches.some((patch) => !patch))
    return radarNoChange(model, source, "radar.patch-unavailable");
  const resolvedCurvePatches = curvePatches.filter((patch) => patch !== null);
  const fallback = model.axes.filter((candidate) => candidate.id !== axis.id)[
    Math.min(axis.order, model.axes.length - 2)
  ];
  const commentPatches = model.comments.flatMap((comment) => {
    if (comment.anchor.kind !== "axis" || comment.anchor.id !== axis.id)
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
    patches: [axisPatch, ...resolvedCurvePatches, ...commentPatches],
    selectionAfter: fallback
      ? { id: fallback.id, kind: "axis" }
      : { kind: "diagram" },
    source,
  });
}

export function applyMermaidRadarAxisCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarAxisCommand;
  if (command.type === "axis.add") return addAxis(context, command);
  if (command.type === "axis.label") return labelAxis(context, command);
  if (command.type === "axis.name") return renameAxis(context, command);
  if (command.type === "axis.reorder") return reorderAxis(context, command);
  if (command.type === "axis.delete") return deleteAxis(context, command);
  return radarNoChange(context.model, context.source, "radar.command-invalid");
}
