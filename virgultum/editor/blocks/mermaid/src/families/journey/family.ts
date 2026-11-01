// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidJourneySource,
  type MermaidJourneyModel,
} from "../../engine/journey/index.js";
import { mermaidMessages as messages } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { mermaidJourneyEmbeddedActions } from "./edgeless-actions.js";
export function journeyFamilyDiagnostics(model: MermaidJourneyModel) {
  return model.diagnostics.map((error) => ({
    code: error.code,
    message: messages.journeyDiagnostic(
      error.code,
      error.range.start,
      error.range.end,
      error.range.line,
    ),
    severity: "error" as const,
  }));
}
export const mermaidJourneyFamily: MermaidFamilyModule<
  MermaidJourneyModel,
  MermaidJourneyModel
> = {
  id: "journey",
  diagramTypes: ["journey"],
  inspector: [],
  commands: mermaidJourneyEmbeddedActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId.endsWith(".add") ? "create" : "edit",
  })),
  toolbar: mermaidJourneyEmbeddedActions,
  parseSource: (source, type) => {
    const model = type === "journey" ? parseMermaidJourneySource(source) : null;
    return {
      source,
      diagramType: "journey",
      model,
      diagnostics: model ? journeyFamilyDiagnostics(model) : [],
    };
  },
  applyVisualToSource: (_model, source) => ({
    source,
    diagnostics: [
      {
        code: "journey.command-required",
        message: messages.visualMutationOwnerUnavailable("Journey"),
        severity: "error",
      },
    ],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
  toVisualModel: (parsed) =>
    parsed.model
      ? {
          kind: "editable",
          visualModel: parsed.model,
          diagnostics: parsed.diagnostics,
        }
      : {
          kind: "source-only",
          reason: messages.mmdImportInvalid(),
          diagnostics: parsed.diagnostics,
        },
};
