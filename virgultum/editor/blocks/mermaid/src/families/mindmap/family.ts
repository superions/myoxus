// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidMindmapSource,
  type MermaidMindmapModel,
} from "../../engine/mindmap/index.js";
import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { formatMindmapDiagnostic } from "./readback.js";
export const mermaidMindmapFamily: MermaidFamilyModule<
  MermaidMindmapModel,
  MermaidMindmapModel,
  Record<string, never>
> = {
  id: "mindmap",
  diagramTypes: ["mindmap"],
  commands: [],
  inspector: [],
  toolbar: [],
  parseSource: (source) => {
    const result = resolveMermaidMindmapSource(source);
    return {
      source,
      diagramType: "mindmap",
      model: result.model,
      diagnostics: result.diagnostics.map((d) => ({
        ...d,
        message: formatMindmapDiagnostic(d),
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
          reason:
            result.diagnostics[0]?.message ??
            mermaidMessages.mmdImportInvalid(),
        },
  applyVisualToSource: (model) => ({
    source: model.sourceDocument.source,
    diagnostics: [],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
};
