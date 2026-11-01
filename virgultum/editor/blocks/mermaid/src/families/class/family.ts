// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidClassSource,
  classSourceDiagnostic,
  type MermaidClassModel,
} from "../../engine/class/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
export const CLASS_DIAGRAM_TYPES = ["classDiagram", "classDiagram-v2"] as const;
export function isClassDiagramType(
  type: string,
): type is (typeof CLASS_DIAGRAM_TYPES)[number] {
  return CLASS_DIAGRAM_TYPES.includes(
    type as (typeof CLASS_DIAGRAM_TYPES)[number],
  );
}
export const mermaidClassFamily: MermaidFamilyModule<
  MermaidClassModel,
  MermaidClassModel,
  Record<string, never>
> = {
  id: "class",
  diagramTypes: CLASS_DIAGRAM_TYPES,
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source, diagramType) => {
    const result = resolveMermaidClassSource(source);
    return {
      source,
      diagramType: isClassDiagramType(diagramType)
        ? diagramType
        : "classDiagram",
      model: result.model,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        message: classSourceDiagnostic(d),
        severity: "error" as const,
      })),
    };
  },
  toVisualModel: (result) =>
    result.model
      ? {
          kind: "editable",
          visualModel: result.model,
          diagnostics: result.diagnostics,
        }
      : {
          kind: "source-only",
          diagnostics: result.diagnostics,
          reason: result.diagnostics[0]?.message ?? "Invalid Class Source",
        },
  applyVisualToSource: (model) => ({
    source: model.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
