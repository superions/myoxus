// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyModel } from "../model.js";
import { DEFAULT_MERMAID_XY_CONFIG } from "../model.js";
import type {
  MermaidXyOrientation,
  MermaidXyTextForm,
} from "../source-document.js";
import { mermaidXyTextFitsForm } from "../source-document.js";
import {
  changesXyOrder,
  finiteXyNumber,
  invalidXyCommand,
  normalizedXyText,
  validXyCommand,
} from "./shared.js";

export type MermaidXyAxisCommand =
  | {
      axis: "x" | "y";
      form?: MermaidXyTextForm;
      title: string;
      type: "axis.title";
    }
  | {
      axis: "x" | "y";
      automatic?: false;
      maximum: number;
      minimum: number;
      type: "axis.range";
    }
  | { automatic: true; axis: "y"; type: "axis.range" }
  | {
      categories?: readonly { form?: MermaidXyTextForm; label: string }[];
      confirmCategoryIds?: readonly string[];
      kind: "auto" | "band" | "linear";
      type: "axis.x-model";
    }
  | { orientation: MermaidXyOrientation; type: "axis.orientation" };

export type MermaidXyCategoryCommand =
  | {
      afterCategoryId?: string;
      form?: MermaidXyTextForm;
      label: string;
      values: readonly {
        label?: string;
        labelForm?: MermaidXyTextForm;
        plotId: string;
        value: number;
      }[];
      type: "category.add";
    }
  | { categoryId: string; label: string; type: "category.rename" }
  | { beforeCategoryId?: string; categoryId: string; type: "category.reorder" }
  | {
      categoryId: string;
      confirmAffectedPlotIds: readonly string[];
      type: "category.delete";
    };

export function validateMermaidXyAxisCommand(
  model: MermaidXyModel,
  command: MermaidXyAxisCommand | MermaidXyCategoryCommand,
) {
  if (command.type === "axis.title") {
    if (command.title && !normalizedXyText(command.title))
      return invalidXyCommand("xy.axis-title-empty");
    const current = command.axis === "x" ? model.xAxis : model.yAxis;
    const title = command.title.trim();
    const selection = {
      id: command.axis === "x" ? "xy-axis-x" : "xy-axis-y",
      kind: command.axis === "x" ? ("x-axis" as const) : ("y-axis" as const),
    };
    if (
      title === current.title &&
      (!title || (command.form ?? current.titleForm) === current.titleForm)
    )
      return invalidXyCommand("xy.no-change", selection);
    if (
      command.title &&
      !mermaidXyTextFitsForm(
        command.title.trim(),
        command.form ?? current.titleForm ?? "plain",
      )
    )
      return invalidXyCommand("xy.text-form-invalid");
    return validXyCommand(selection);
  }
  if (command.type === "axis.range") {
    if (command.automatic)
      return model.yAxis.rangeExplicit
        ? validXyCommand({ id: "xy-axis-y", kind: "y-axis" })
        : invalidXyCommand("xy.no-change", {
            id: "xy-axis-y",
            kind: "y-axis",
          });
    if (
      !finiteXyNumber(command.minimum) ||
      !finiteXyNumber(command.maximum) ||
      command.minimum >= command.maximum
    )
      return invalidXyCommand("xy.axis-range-invalid");
    if (command.axis === "x" && model.xAxis.effectiveKind !== "linear")
      return invalidXyCommand("xy.axis-model-impact-confirmation-required", {
        id: "xy-axis-x",
        kind: "x-axis",
      });
    const current = command.axis === "x" ? model.xAxis : model.yAxis;
    if (
      command.minimum ===
        ("effectiveMinimum" in current
          ? current.effectiveMinimum
          : current.minimum) &&
      command.maximum ===
        ("effectiveMaximum" in current
          ? current.effectiveMaximum
          : current.maximum) &&
      (command.axis === "x" || model.yAxis.rangeExplicit)
    )
      return invalidXyCommand("xy.no-change", {
        id: command.axis === "x" ? "xy-axis-x" : "xy-axis-y",
        kind: command.axis === "x" ? "x-axis" : "y-axis",
      });
    return validXyCommand({
      id: command.axis === "x" ? "xy-axis-x" : "xy-axis-y",
      kind: command.axis === "x" ? "x-axis" : "y-axis",
    });
  }
  if (command.type === "axis.x-model") {
    const currentKind =
      model.xAxis.sourceForm === "band" || model.xAxis.sourceForm === "linear"
        ? model.xAxis.sourceForm
        : "auto";
    if (command.kind === currentKind)
      return invalidXyCommand("xy.no-change", {
        id: "xy-axis-x",
        kind: "x-axis",
      });
    if (
      model.xAxis.effectiveKind === "band" &&
      command.kind !== "band" &&
      (command.confirmCategoryIds?.length !== model.xAxis.categories.length ||
        model.xAxis.categories.some(
          (category) => !command.confirmCategoryIds?.includes(category.id),
        ))
    )
      return invalidXyCommand("xy.axis-model-impact-confirmation-required", {
        id: "xy-axis-x",
        kind: "x-axis",
      });
    if (command.kind === "band") {
      const required = Math.max(
        1,
        ...model.plots.map((plot) => plot.points.length),
      );
      if (
        command.categories?.length !== required ||
        command.categories.some(
          (category) =>
            !normalizedXyText(category.label) ||
            !mermaidXyTextFitsForm(
              category.label.trim(),
              category.form ?? "quoted",
            ),
        )
      )
        return invalidXyCommand("xy.axis-band-categories-incomplete", {
          id: "xy-axis-x",
          kind: "x-axis",
        });
    }
    return validXyCommand({ id: "xy-axis-x", kind: "x-axis" });
  }
  if (command.type === "axis.orientation") {
    const sourceOrientation =
      model.headerOrientation ??
      model.config.chartOrientation ??
      DEFAULT_MERMAID_XY_CONFIG.chartOrientation;
    if (command.orientation === sourceOrientation)
      return invalidXyCommand("xy.no-change");
    return validXyCommand({ kind: "diagram" });
  }
  if (command.type === "category.add") {
    if (!normalizedXyText(command.label))
      return invalidXyCommand("xy.category-label-empty");
    if (!mermaidXyTextFitsForm(command.label.trim(), command.form ?? "quoted"))
      return invalidXyCommand("xy.text-form-invalid");
    if (model.xAxis.effectiveKind !== "band")
      return invalidXyCommand("xy.category-band-only");
    if (
      model.plots.some(
        (plot) => plot.points.length !== model.xAxis.categories.length,
      )
    )
      return invalidXyCommand("xy.category-mismatch-resolution-required", {
        id: "xy-axis-x",
        kind: "x-axis",
      });
    const plotIds = model.plots.map((plot) => plot.id);
    if (
      command.values.length !== plotIds.length ||
      command.values.some(
        (entry) =>
          !plotIds.includes(entry.plotId) ||
          !finiteXyNumber(entry.value) ||
          (entry.label !== undefined &&
            (!normalizedXyText(entry.label) ||
              !mermaidXyTextFitsForm(
                entry.label.trim(),
                entry.labelForm ?? "plain",
              ))),
      ) ||
      new Set(command.values.map((entry) => entry.plotId)).size !==
        plotIds.length
    )
      return invalidXyCommand("xy.category-values-incomplete");
    if (
      command.afterCategoryId &&
      !model.xAxis.categories.some(
        (item) => item.id === command.afterCategoryId,
      )
    )
      return invalidXyCommand("xy.category-anchor-not-found");
    return validXyCommand({ kind: "x-axis", id: "xy-axis-x" });
  }
  const category = model.xAxis.categories.find(
    (item) => item.id === command.categoryId,
  );
  if (!category) return invalidXyCommand("xy.category-not-found");
  if (command.type === "category.rename") {
    const label = normalizedXyText(command.label);
    if (!label) return invalidXyCommand("xy.category-label-empty");
    if (!mermaidXyTextFitsForm(label, category.textForm))
      return invalidXyCommand("xy.text-form-invalid");
    if (label === category.label)
      return invalidXyCommand("xy.no-change", {
        id: category.id,
        kind: "category",
      });
  }
  if (
    command.type === "category.reorder" &&
    command.beforeCategoryId &&
    !model.xAxis.categories.some((item) => item.id === command.beforeCategoryId)
  )
    return invalidXyCommand("xy.category-anchor-not-found");
  if (
    command.type === "category.reorder" &&
    !changesXyOrder(
      model.xAxis.categories.map((item) => item.id),
      category.id,
      command.beforeCategoryId,
    )
  )
    return invalidXyCommand("xy.no-change", {
      id: category.id,
      kind: "category",
    });
  if (
    command.type === "category.reorder" &&
    model.plots.some(
      (plot) => plot.points.length !== model.xAxis.categories.length,
    )
  )
    return invalidXyCommand("xy.category-mismatch-resolution-required", {
      id: category.id,
      kind: "category",
    });
  if (command.type === "category.delete") {
    if (model.xAxis.categories.length === 1)
      return invalidXyCommand("xy.category-minimum", {
        id: category.id,
        kind: "category",
      });
    if (
      category.order === 0 &&
      model.plots.some((plot) => plot.points.length === 1)
    )
      return invalidXyCommand("xy.category-delete-empty-plot", {
        id: category.id,
        kind: "category",
      });
    const affected = model.plots
      .filter((plot) => plot.points.length > category.order)
      .map((plot) => plot.id);
    if (
      affected.some((id) => !command.confirmAffectedPlotIds.includes(id)) ||
      command.confirmAffectedPlotIds.some((id) => !affected.includes(id))
    )
      return invalidXyCommand("xy.category-impact-confirmation-required", {
        id: category.id,
        kind: "category",
      });
  }
  return validXyCommand({ id: category.id, kind: "category" });
}
