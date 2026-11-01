// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidKanbanSource,
  type MermaidKanbanModel,
} from "../../engine/kanban/index.js";
import { mermaidMessages as messages } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { mermaidKanbanEmbeddedActions } from "./edgeless-actions.js";
export function kanbanFamilyDiagnostics(model: MermaidKanbanModel) {
  return model.diagnostics.map((error) => ({
    code: error.code,
    message: messages.kanbanDiagnostic(
      error.code,
      error.range.start,
      error.range.end,
      error.range.line,
    ),
    severity: "error" as const,
  }));
}
export const mermaidKanbanFamily: MermaidFamilyModule<
  MermaidKanbanModel,
  MermaidKanbanModel
> = {
  id: "kanban",
  diagramTypes: ["kanban"],
  inspector: [],
  commands: mermaidKanbanEmbeddedActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId.endsWith(".add") ? "create" : "edit",
  })),
  toolbar: mermaidKanbanEmbeddedActions,
  parseSource: (source, type) => {
    const model = type === "kanban" ? parseMermaidKanbanSource(source) : null;
    return {
      source,
      diagramType: "kanban",
      model,
      diagnostics: model ? kanbanFamilyDiagnostics(model) : [],
    };
  },
  applyVisualToSource: (_model, source) => ({
    source,
    diagnostics: [
      {
        code: "kanban.command-required",
        message: messages.visualMutationOwnerUnavailable("Kanban"),
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
