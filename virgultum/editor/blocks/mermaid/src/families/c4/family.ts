// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidC4SourceWithDiagnostics,
  type MermaidC4Model,
} from "../../engine/c4/index.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { mermaidMessages as m } from "../../i18n.js";

export function isC4DiagramType(type: string): type is "c4" {
  return type === "c4";
}

/** C4 syntax and native ordered effects have one Source model for every header. */
export const mermaidC4Family: MermaidFamilyModule<
  MermaidC4Model,
  MermaidC4Model,
  Record<string, never>
> = {
  id: "c4",
  diagramTypes: ["c4"],
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source) => {
    const parsed = parseMermaidC4SourceWithDiagnostics(source);
    return {
      source,
      diagramType: "c4",
      model: parsed.projectionRenderable ? parsed.model : null,
      diagnostics: parsed.diagnostics,
    };
  },
  toVisualModel: (parsed) =>
    parsed.model
      ? {
          kind: "editable",
          visualModel: parsed.model,
          diagnostics: parsed.diagnostics,
        }
      : {
          kind: "source-only",
          diagnostics: parsed.diagnostics,
          reason: parsed.diagnostics[0]?.message ?? m.classPatchRejected(),
        },
  applyVisualToSource: (model) => ({
    source: model.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
