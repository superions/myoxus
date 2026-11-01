// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "../../diagram-title.js";
import type { MermaidRequirementModel } from "../model.js";
import {
  requirementNoChange,
  writeRequirementPatches,
  type RequirementWriteOptions,
} from "../writer.js";

export function readRequirementDiagramTitle(model: MermaidRequirementModel) {
  return resolveMermaidDiagramTitle({
    diagramType: "requirementDiagram",
    source: model.sourceDocument?.source ?? "",
  }).value;
}
/** Delegate scalar syntax and ownership to the common YAML/CST title writer;
 * feed only its changed range through this family's checked binding writer. */
export function editRequirementDiagramTitle(
  model: MermaidRequirementModel,
  title: string,
  options: RequirementWriteOptions = {},
) {
  const source = model.sourceDocument?.source;
  if (source === undefined) return requirementNoChange(model, "invalid");
  const next = writeMermaidDiagramTitle({
    diagramType: "requirementDiagram",
    source,
    title,
  });
  if (next === null) return requirementNoChange(model, "invalid");
  if (next === source) return requirementNoChange(model);
  let start = 0,
    end = source.length,
    nextEnd = next.length;
  while (start < end && start < nextEnd && source[start] === next[start])
    start++;
  while (
    end > start &&
    nextEnd > start &&
    source[end - 1] === next[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  return writeRequirementPatches(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    options,
  );
}
