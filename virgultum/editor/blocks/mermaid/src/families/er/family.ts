// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidErSource,
  erSourceDiagnostic,
  type MermaidErModel,
} from "../../engine/er/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
export const ER_DIAGRAM_TYPES = ["erDiagram"] as const;
export function isErDiagramType(
  type: string,
): type is (typeof ER_DIAGRAM_TYPES)[number] {
  return ER_DIAGRAM_TYPES.includes(type as (typeof ER_DIAGRAM_TYPES)[number]);
}
export const mermaidErFamily: MermaidFamilyModule<
  MermaidErModel,
  MermaidErModel,
  Record<string, never>
> = {
  id: "er",
  diagramTypes: ER_DIAGRAM_TYPES,
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source, diagramType) => {
    const result = resolveMermaidErSource(source);
    return {
      source,
      diagramType: isErDiagramType(diagramType) ? diagramType : "erDiagram",
      model: result.model,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        message: erSourceDiagnostic(d),
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
          reason: result.diagnostics[0]?.message ?? "Invalid ER Source",
        },
  applyVisualToSource: (model) => ({
    source: model.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
