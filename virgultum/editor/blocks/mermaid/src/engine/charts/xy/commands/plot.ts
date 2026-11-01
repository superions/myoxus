// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyModel, MermaidXyPlotKind } from "../model.js";
import type { MermaidXyTextForm } from "../source-document.js";
import { mermaidXyTextFitsForm } from "../source-document.js";
import {
  changesXyOrder,
  invalidXyCommand,
  normalizedXyText,
  validXyCommand,
} from "./shared.js";

export type MermaidXyPlotCommand =
  | {
      afterPlotId?: string;
      kind: MermaidXyPlotKind;
      points: readonly {
        label?: string;
        labelForm?: MermaidXyTextForm;
        value: number;
      }[];
      title?: string;
      titleForm?: MermaidXyTextForm;
      type: "plot.add";
    }
  | {
      plotId: string;
      title: string;
      titleForm?: MermaidXyTextForm;
      type: "plot.rename";
    }
  | { plotId: string; titleForm: MermaidXyTextForm; type: "plot.title-form" }
  | { kind: MermaidXyPlotKind; plotId: string; type: "plot.kind" }
  | { beforePlotId?: string; plotId: string; type: "plot.reorder" }
  | { plotId: string; type: "plot.delete" };

export function validateMermaidXyPlotCommand(
  model: MermaidXyModel,
  command: MermaidXyPlotCommand,
) {
  if (command.type === "plot.add") {
    const requiredPointCount =
      model.xAxis.effectiveKind === "band"
        ? model.xAxis.categories.length
        : null;
    if (
      command.points.length === 0 ||
      (requiredPointCount !== null &&
        command.points.length !== requiredPointCount)
    )
      return invalidXyCommand("xy.plot-points-incomplete");
    if (
      command.points.some(
        (point) =>
          !Number.isFinite(point.value) ||
          (point.label !== undefined &&
            (!normalizedXyText(point.label) ||
              !mermaidXyTextFitsForm(
                point.label.trim(),
                point.labelForm ?? "plain",
              ))),
      )
    )
      return invalidXyCommand("xy.plot-point-invalid");
    if (
      command.title?.trim() &&
      !mermaidXyTextFitsForm(
        command.title.trim(),
        command.titleForm ?? "quoted",
      )
    )
      return invalidXyCommand("xy.text-form-invalid");
    if (
      command.afterPlotId &&
      !model.plots.some((plot) => plot.id === command.afterPlotId)
    )
      return invalidXyCommand("xy.plot-anchor-not-found");
    return validXyCommand({ kind: "diagram" });
  }
  const plot = model.plots.find((candidate) => candidate.id === command.plotId);
  if (!plot) return invalidXyCommand("xy.plot-not-found");
  const selection = { id: plot.id, kind: "plot" as const };
  if (command.type === "plot.rename") {
    const title = normalizedXyText(command.title);
    if (
      title &&
      !mermaidXyTextFitsForm(
        title,
        command.titleForm ?? plot.titleForm ?? "quoted",
      )
    )
      return invalidXyCommand("xy.text-form-invalid", selection);
    if (
      (title === plot.title &&
        plot.titleExplicit &&
        (command.titleForm ?? plot.titleForm) === plot.titleForm) ||
      (!title && !plot.titleExplicit)
    )
      return invalidXyCommand("xy.no-change", selection);
  }
  if (
    command.type === "plot.title-form" &&
    (!plot.titleExplicit ||
      command.titleForm === plot.titleForm ||
      !mermaidXyTextFitsForm(plot.title, command.titleForm))
  )
    return invalidXyCommand(
      plot.titleExplicit && command.titleForm !== plot.titleForm
        ? "xy.text-form-invalid"
        : "xy.no-change",
      selection,
    );
  if (command.type === "plot.kind" && command.kind === plot.kind)
    return invalidXyCommand("xy.no-change", selection);
  if (
    command.type === "plot.reorder" &&
    command.beforePlotId &&
    !model.plots.some((item) => item.id === command.beforePlotId)
  )
    return invalidXyCommand("xy.plot-anchor-not-found", selection);
  if (
    command.type === "plot.reorder" &&
    !changesXyOrder(
      model.plots.map((item) => item.id),
      plot.id,
      command.beforePlotId,
    )
  )
    return invalidXyCommand("xy.no-change", selection);
  return validXyCommand(selection);
}
