// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidMessages as m } from "../../i18n.js";
import {
  resolveMermaidStateSource,
  stateSourceDiagnostic,
  type MermaidStateModel,
} from "../../engine/state/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
export const STATE_DIAGRAM_TYPES = ["stateDiagram", "stateDiagram-v2"] as const;
export function isStateDiagramType(
  type: string,
): type is (typeof STATE_DIAGRAM_TYPES)[number] {
  return type === "stateDiagram" || type === "stateDiagram-v2";
}
export const mermaidStateFamily: MermaidFamilyModule<
  MermaidStateModel,
  MermaidStateModel,
  Record<string, never>
> = {
  id: "state",
  diagramTypes: STATE_DIAGRAM_TYPES,
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source, diagramType) => {
    const result = resolveMermaidStateSource(source);
    return {
      source,
      diagramType: isStateDiagramType(diagramType)
        ? diagramType
        : "stateDiagram",
      model: isStateDiagramType(diagramType) ? result.model : null,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        message: stateSourceDiagnostic(d),
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
          reason: result.diagnostics[0]?.message ?? m.stateInvalidRecord(),
        },
  applyVisualToSource: (model) => ({
    source: model.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
