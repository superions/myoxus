// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  generateMermaidRequirementSource,
  resolveMermaidRequirementSource,
  type MermaidRequirementModel,
} from "../../engine/requirement/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";

export const REQUIREMENT_DIAGRAM_TYPES = ["requirementDiagram"] as const;
export function isRequirementDiagramType(
  type: string,
): type is "requirementDiagram" {
  return type === "requirementDiagram";
}
export const mermaidRequirementFamily: MermaidFamilyModule<
  MermaidRequirementModel,
  MermaidRequirementModel,
  Record<string, never>
> = {
  id: "requirement",
  diagramTypes: REQUIREMENT_DIAGRAM_TYPES,
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source, type) => {
    const result = resolveMermaidRequirementSource(source);
    const supported = isRequirementDiagramType(type);
    return {
      source,
      diagramType: "requirementDiagram",
      model: supported ? result.model : null,
      diagnostics: supported
        ? result.diagnostics.map((d) => ({
            code: d.code,
            severity: d.severity,
            message: m.sourceDiagnostic(
              d.range.line,
              d.range.start,
              d.range.end,
              d.construct,
            ),
          }))
        : [
            {
              code: "requirement.unsupported-diagram-type",
              severity: "error",
              message: m.mmdImportInvalid(),
            },
          ],
    };
  },
  toVisualModel: (parsed) =>
    parsed.model
      ? {
          kind: "editable",
          diagnostics: parsed.diagnostics,
          visualModel: parsed.model,
        }
      : {
          kind: "source-only",
          diagnostics: parsed.diagnostics,
          reason: m.mmdImportInvalid(),
        },
  applyVisualToSource: (model) => ({
    source: generateMermaidRequirementSource(model),
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
