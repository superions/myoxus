// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidMessages as m } from "../../i18n.js";
import {
  resolveMermaidSequenceSource,
  sequenceSourceDiagnostic,
  type MermaidSequenceModel,
} from "../../engine/sequence/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
export const SEQUENCE_DIAGRAM_TYPES = ["sequenceDiagram"] as const;
export function isSequenceDiagramType(type: string): type is "sequenceDiagram" {
  return type === "sequenceDiagram";
}
export const mermaidSequenceFamily: MermaidFamilyModule<
  MermaidSequenceModel,
  MermaidSequenceModel,
  Record<string, never>
> = {
  id: "sequence",
  diagramTypes: SEQUENCE_DIAGRAM_TYPES,
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source, _diagramType) => {
    const result = resolveMermaidSequenceSource(source);
    return {
      source,
      diagramType: "sequenceDiagram",
      model: result.model,
      diagnostics: result.diagnostics.map((d) => ({
        code: d.code,
        message: sequenceSourceDiagnostic(d),
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
          reason: result.diagnostics[0]?.message ?? m.sequenceInvalidRecord(),
        },
  applyVisualToSource: (model) => ({
    source: model.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
