// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyModel } from "../model.js";
import type { MermaidXyTextForm } from "../source-document.js";
import { mermaidXyTextFitsForm } from "../source-document.js";
import {
  changesXyOrder,
  finiteXyNumber,
  invalidXyCommand,
  normalizedXyText,
  validXyCommand,
} from "./shared.js";

export type MermaidXyPointCommand =
  | {
      afterPointId?: string;
      label?: string;
      labelForm?: MermaidXyTextForm;
      plotId: string;
      type: "point.add";
      value: number;
    }
  | {
      pointId: string;
      type: "point.label";
      label: string;
      labelForm?: MermaidXyTextForm;
    }
  | { pointId: string; type: "point.label-form"; labelForm: MermaidXyTextForm }
  | { pointId: string; type: "point.value"; value: number }
  | { beforePointId?: string; pointId: string; type: "point.reorder" }
  | { pointId: string; type: "point.delete" };

export function findMermaidXyPoint(model: MermaidXyModel, pointId: string) {
  for (const plot of model.plots) {
    const point = plot.points.find((candidate) => candidate.id === pointId);
    if (point) return { plot, point };
  }
  return null;
}

export function validateMermaidXyPointCommand(
  model: MermaidXyModel,
  command: MermaidXyPointCommand,
) {
  if (command.type === "point.add") {
    const plot = model.plots.find(
      (candidate) => candidate.id === command.plotId,
    );
    if (!plot) return invalidXyCommand("xy.plot-not-found");
    if (!finiteXyNumber(command.value))
      return invalidXyCommand("xy.point-value-invalid", {
        id: plot.id,
        kind: "plot",
      });
    if (
      command.label !== undefined &&
      (!normalizedXyText(command.label) ||
        !mermaidXyTextFitsForm(
          command.label.trim(),
          command.labelForm ?? "plain",
        ))
    )
      return invalidXyCommand("xy.point-label-empty", {
        id: plot.id,
        kind: "plot",
      });
    if (
      command.afterPointId &&
      !plot.points.some((point) => point.id === command.afterPointId)
    )
      return invalidXyCommand("xy.point-anchor-not-found", {
        id: plot.id,
        kind: "plot",
      });
    return validXyCommand({ id: plot.id, kind: "plot" });
  }
  const found = findMermaidXyPoint(model, command.pointId);
  if (!found) return invalidXyCommand("xy.point-not-found");
  const selection = { id: found.point.id, kind: "point" as const };
  if (command.type === "point.delete" && found.plot.points.length === 1)
    return invalidXyCommand("xy.plot-point-minimum", selection);
  if (command.type === "point.value") {
    if (!finiteXyNumber(command.value))
      return invalidXyCommand("xy.point-value-invalid", selection);
    if (command.value === found.point.value)
      return invalidXyCommand("xy.no-change", selection);
  }
  if (command.type === "point.label") {
    if (command.label && !normalizedXyText(command.label))
      return invalidXyCommand("xy.point-label-empty", selection);
    if (
      command.label === found.point.label &&
      (command.labelForm ?? found.point.labelForm) === found.point.labelForm
    )
      return invalidXyCommand("xy.no-change", selection);
    if (
      command.label &&
      !mermaidXyTextFitsForm(
        command.label.trim(),
        command.labelForm ?? found.point.labelForm ?? "plain",
      )
    )
      return invalidXyCommand("xy.text-form-invalid", selection);
  }
  if (
    command.type === "point.label-form" &&
    (!found.point.label ||
      command.labelForm === found.point.labelForm ||
      !mermaidXyTextFitsForm(found.point.label, command.labelForm))
  )
    return invalidXyCommand(
      !found.point.label || command.labelForm === found.point.labelForm
        ? "xy.no-change"
        : "xy.text-form-invalid",
      selection,
    );
  if (
    command.type === "point.reorder" &&
    command.beforePointId &&
    !found.plot.points.some((point) => point.id === command.beforePointId)
  )
    return invalidXyCommand("xy.point-anchor-not-found", selection);
  if (
    command.type === "point.reorder" &&
    !changesXyOrder(
      found.plot.points.map((item) => item.id),
      found.point.id,
      command.beforePointId,
    )
  )
    return invalidXyCommand("xy.no-change", selection);
  return validXyCommand(selection);
}
