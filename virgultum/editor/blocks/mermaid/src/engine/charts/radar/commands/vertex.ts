// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidRadarCommandContext,
  MermaidRadarVertexCommand,
} from "./types.js";
import { validRadarValue } from "./types.js";
import {
  mermaidRadarNumber,
  radarEntryAppendPatch,
  radarEntryRemovalRange,
  radarEntrySource,
  radarNoChange,
  radarPatchedResult,
} from "../writer.js";

function vertexSelection(
  result: ReturnType<typeof radarPatchedResult>,
  curveId: string,
  axisId: string,
) {
  const vertex = result.model.curves
    .find((curve) => curve.id === curveId)
    ?.vertices.find((candidate) => candidate.axisId === axisId);
  return vertex && result.changed
    ? { ...result, selectionAfter: { id: vertex.id, kind: "vertex" as const } }
    : result;
}

function addVertex(
  context: MermaidRadarCommandContext,
  command: Extract<
    MermaidRadarVertexCommand,
    { type: "vertex.add" | "vertex.repair" }
  >,
) {
  const { model, source } = context;
  const curve = model.curves.find(
    (candidate) => candidate.id === command.curveId,
  );
  const axis = model.axes.find((candidate) => candidate.id === command.axisId);
  if (!curve || !axis || !validRadarValue(command.value))
    return radarNoChange(model, source, "radar.vertex-invalid");
  if (
    curve.sourceForm === "detailed" &&
    model.axes.filter((candidate) => candidate.name === axis.name).length !== 1
  )
    return radarNoChange(model, source, "radar.reference-invalid");
  if (curve.vertices.find((vertex) => vertex.axisId === axis.id)?.entryId)
    return radarNoChange(model, source, "radar.vertex-exists");
  if (curve.sourceForm === "mixed")
    return radarNoChange(model, source, "radar.mixed-value-form");
  if (curve.sourceForm === "positional" && axis.order !== curve.entries.length)
    return radarNoChange(model, source, "radar.vertex-gap-unresolved");
  const added =
    curve.sourceForm === "detailed"
      ? `${axis.name}${curve.entries[0]?.colon ? ":" : ""} ${mermaidRadarNumber(command.value)}`
      : mermaidRadarNumber(command.value);
  const patch = radarEntryAppendPatch(source, model, curve, added);
  if (!patch) return radarNoChange(model, source, "radar.patch-unavailable");
  return vertexSelection(
    radarPatchedResult({
      model,
      patches: [patch],
      selectionAfter: null,
      source,
    }),
    curve.id,
    axis.id,
  );
}

function setVertexValue(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarVertexCommand, { type: "vertex.value" }>,
) {
  const { model, source } = context;
  const curve = model.curves.find((candidate) =>
    candidate.entries.some((entry) => entry.id === command.entryId),
  );
  const entry = curve?.entries.find(
    (candidate) => candidate.id === command.entryId,
  );
  const sourceInfo = entry ? radarEntrySource(model, entry) : null;
  if (
    !curve ||
    !entry ||
    !sourceInfo?.entry.valueRange ||
    !validRadarValue(command.value)
  )
    return radarNoChange(model, source, "radar.vertex-invalid");
  const axisId =
    entry.axisId ??
    curve.vertices.find((vertex) => vertex.entryId === entry.id)?.axisId;
  const result = radarPatchedResult({
    model,
    patches: [
      {
        range: sourceInfo.entry.valueRange,
        value: mermaidRadarNumber(command.value),
      },
    ],
    selectionAfter: null,
    source,
  });
  return axisId ? vertexSelection(result, curve.id, axisId) : result;
}

function setReference(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarVertexCommand, { type: "vertex.reference" }>,
) {
  const { model, source } = context;
  const curve = model.curves.find((candidate) =>
    candidate.entries.some((entry) => entry.id === command.entryId),
  );
  const entry = curve?.entries.find(
    (candidate) => candidate.id === command.entryId,
  );
  const axis = model.axes.find((candidate) => candidate.id === command.axisId);
  const sourceInfo = entry ? radarEntrySource(model, entry) : null;
  if (
    !curve ||
    curve.sourceForm !== "detailed" ||
    !entry ||
    !axis ||
    !sourceInfo?.entry.axisNameRange ||
    model.axes.filter((candidate) => candidate.name === axis.name).length !==
      1 ||
    curve.entries.some(
      (candidate) =>
        candidate.id !== entry.id && candidate.axisName === axis.name,
    )
  )
    return radarNoChange(model, source, "radar.reference-invalid");
  const result = radarPatchedResult({
    model,
    patches: [{ range: sourceInfo.entry.axisNameRange, value: axis.name }],
    selectionAfter: null,
    source,
  });
  return vertexSelection(result, curve.id, axis.id);
}

function deleteVertex(
  context: MermaidRadarCommandContext,
  command: Extract<MermaidRadarVertexCommand, { type: "vertex.delete" }>,
) {
  const { model, source } = context;
  const curve = model.curves.find((candidate) =>
    candidate.entries.some((entry) => entry.id === command.entryId),
  );
  const entry = curve?.entries.find(
    (candidate) => candidate.id === command.entryId,
  );
  const sourceInfo = entry ? radarEntrySource(model, entry) : null;
  if (!curve || !entry || !sourceInfo)
    return radarNoChange(model, source, "radar.vertex-missing");
  const axisId =
    entry.axisId ??
    curve.vertices.find((vertex) => vertex.entryId === entry.id)?.axisId;
  const result = radarPatchedResult({
    model,
    patches: [
      {
        range: radarEntryRemovalRange(
          sourceInfo.record,
          sourceInfo.entry,
          sourceInfo.curveSource.entries,
        ),
        value: "",
      },
    ],
    selectionAfter: { id: curve.id, kind: "curve" },
    source,
  });
  if (!axisId || !result.changed) return result;
  const nextCurve = result.model.curves.find(
    (candidate) => candidate.id === curve.id,
  );
  const missing =
    nextCurve?.vertices.find((vertex) => vertex.state === "missing") ??
    nextCurve?.vertices.find((vertex) => vertex.axisId === axisId);
  return missing
    ? {
        ...result,
        selectionAfter: { id: missing.id, kind: "vertex" as const },
      }
    : result;
}

export function applyMermaidRadarVertexCommand(
  context: MermaidRadarCommandContext,
) {
  const command = context.command as MermaidRadarVertexCommand;
  if (command.type === "vertex.add" || command.type === "vertex.repair")
    return addVertex(context, command);
  if (command.type === "vertex.value") return setVertexValue(context, command);
  if (command.type === "vertex.reference")
    return setReference(context, command);
  if (command.type === "vertex.delete") return deleteVertex(context, command);
  return radarNoChange(context.model, context.source, "radar.command-invalid");
}
