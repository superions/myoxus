// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyConfig, MermaidXyModel } from "../model.js";
import type { MermaidXyTextForm } from "../source-document.js";
import { mermaidXyTextFitsForm } from "../source-document.js";
import {
  invalidXyCommand,
  normalizedXyText,
  validXyCommand,
} from "./shared.js";

const ROOT_BOOLEAN_FIELDS = [
  "showDataLabel",
  "showDataLabelOutsideBar",
  "showTitle",
  "useMaxWidth",
] as const;
const ROOT_NON_NEGATIVE_FIELDS = ["titlePadding"] as const;

export function validMermaidXyConfigFieldValue(field: string, value: unknown) {
  if (field === "chartOrientation")
    return value === "horizontal" || value === "vertical";
  if (
    ROOT_BOOLEAN_FIELDS.includes(field as (typeof ROOT_BOOLEAN_FIELDS)[number])
  )
    return typeof value === "boolean";
  if (
    /^(?:xAxis|yAxis)\.(?:showAxisLine|showLabel|showTick|showTitle)$/.test(
      field,
    )
  )
    return typeof value === "boolean";
  if (field === "plotReservedSpacePercent")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value < 100
    );
  if (
    ROOT_NON_NEGATIVE_FIELDS.includes(
      field as (typeof ROOT_NON_NEGATIVE_FIELDS)[number],
    ) ||
    /^(?:xAxis|yAxis)\.(?:labelPadding|titlePadding)$/.test(field)
  )
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (/^(?:xAxis|yAxis)\.labelRotation$/.test(field))
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validMermaidXyConfig(config: MermaidXyConfig) {
  const fields = [
    ...Object.entries(config).filter(
      ([field]) => field !== "xAxis" && field !== "yAxis",
    ),
    ...Object.entries(config.xAxis ?? {}).map(
      ([field, value]) => [`xAxis.${field}`, value] as const,
    ),
    ...Object.entries(config.yAxis ?? {}).map(
      ([field, value]) => [`yAxis.${field}`, value] as const,
    ),
  ];
  return fields.every(
    ([field, value]) =>
      value === undefined || validMermaidXyConfigFieldValue(field, value),
  );
}

export type MermaidXyAppearanceCommand =
  | { config: MermaidXyConfig; type: "appearance.config" }
  | { title: string; titleForm?: MermaidXyTextForm; type: "diagram.title" }
  | { description: string; title: string; type: "diagram.accessibility" };

export function validateMermaidXyAppearanceCommand(
  model: MermaidXyModel,
  command: MermaidXyAppearanceCommand,
) {
  if (command.type === "diagram.title") {
    if (command.title && !normalizedXyText(command.title))
      return invalidXyCommand("xy.title-empty");
    if (
      command.title &&
      !mermaidXyTextFitsForm(
        command.title.trim(),
        command.titleForm ?? model.titleForm ?? "quoted",
      )
    )
      return invalidXyCommand("xy.text-form-invalid");
    if (
      command.title === model.title &&
      (command.titleForm ?? model.titleForm) === model.titleForm
    )
      return invalidXyCommand("xy.no-change");
  }
  if (
    command.type === "diagram.accessibility" &&
    (/[\r\n]/.test(command.title) ||
      command.description
        .split(/\r\n|\r|\n/)
        .some((line) => line.trim() === "}"))
  )
    return invalidXyCommand("xy.accessibility-text-invalid");
  if (
    command.type === "diagram.accessibility" &&
    command.title === model.accessibilityTitle &&
    command.description === model.accessibilityDescription
  )
    return invalidXyCommand("xy.no-change");
  if (
    command.type === "appearance.config" &&
    !validMermaidXyConfig(command.config)
  )
    return invalidXyCommand("xy.appearance-invalid");
  if (command.type === "appearance.config") {
    if (JSON.stringify(command.config) === JSON.stringify(model.config))
      return invalidXyCommand("xy.no-change");
  }
  return validXyCommand({ kind: "diagram" });
}
