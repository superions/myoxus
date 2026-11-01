// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidGanttSource } from "../../engine/gantt/parser.js";
import type { MermaidGanttModel } from "../../engine/gantt/types.js";
import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { mermaidGanttEmbeddedActions } from "./edgeless-actions.js";

export function ganttFamilyDiagnostics(model: MermaidGanttModel) {
  return model.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: ganttDiagnosticText(diagnostic),
    severity: "error" as const,
  }));
}

export function ganttDiagnosticMessage(
  diagnostic: MermaidGanttModel["diagnostics"][number],
) {
  const detail = diagnostic.detail ?? "";
  switch (diagnostic.code) {
    case "duplicate-id":
      return mermaidMessages.ganttDiagnosticDuplicateId(detail);
    case "cycle":
      return mermaidMessages.ganttDiagnosticCycle();
    case "invalid-schedule":
      return mermaidMessages.ganttDiagnosticInvalidSchedule();
    case "missing-id":
      return mermaidMessages.ganttDiagnosticInvalidId();
    case "ambiguous-source":
      return `${mermaidMessages.errorLine({ line: diagnostic.range.line })} ${mermaidMessages.ganttAmbiguousSource()}`;
    case "unknown-statement":
      return diagnostic.field === "label"
        ? mermaidMessages.ganttDiagnosticInvalidLabel()
        : mermaidMessages.errorLine({ line: diagnostic.range.line });
    case "unresolved-reference":
      return mermaidMessages.ganttDiagnosticUnresolvedReference(detail);
    case "invalid-date":
      return mermaidMessages.ganttDiagnosticInvalidDate(detail);
    case "invalid-duration":
      return mermaidMessages.ganttDiagnosticInvalidDuration(detail);
    case "conflict":
      return mermaidMessages.chartSourceChanged();
    default:
      return mermaidMessages.errorLine({ line: diagnostic.range.line });
  }
}

/**
 * Localized diagnostic text never leaks a raw `{placeholder}`: when a
 * diagnostic carries no concrete detail, the token is removed rather than
 * shown verbatim.
 */
export function ganttDiagnosticText(
  diagnostic: MermaidGanttModel["diagnostics"][number],
) {
  return ganttDiagnosticMessage(diagnostic)
    .replace(/\{[a-z]+\}/gi, "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Gantt's persisted authority is source; visual models are never serialized. */
export const mermaidGanttFamily: MermaidFamilyModule<
  MermaidGanttModel,
  MermaidGanttModel,
  { readonly readGanttModel?: () => MermaidGanttModel | null }
> = {
  applyVisualToSource: (_model, source) => ({
    diagnostics: [
      {
        code: "gantt.command-required",
        message: mermaidMessages.visualMutationOwnerUnavailable("Gantt"),
        severity: "error",
      },
    ],
    source,
  }),
  commands: mermaidGanttEmbeddedActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId.endsWith(".add") ? "create" : "edit",
  })),
  diagramTypes: ["gantt"],
  id: "gantt",
  inspector: [],
  materializeFrame: () => undefined,
  parseSource: (source, diagramType) => {
    const model =
      diagramType === "gantt" ? parseMermaidGanttSource(source) : null;
    return {
      diagnostics: model
        ? ganttFamilyDiagnostics(model)
        : [
            {
              code: "gantt.header",
              message: mermaidMessages.mmdImportInvalid(),
              severity: "error" as const,
            },
          ],
      diagramType: "gantt",
      model,
      source,
    };
  },
  readFrame: (context) => context.readGanttModel?.() ?? null,
  toolbar: mermaidGanttEmbeddedActions,
  toVisualModel: (parsed) =>
    parsed.model
      ? {
          diagnostics: parsed.diagnostics,
          kind: "editable",
          visualModel: parsed.model,
        }
      : {
          diagnostics: parsed.diagnostics,
          kind: "source-only",
          reason: mermaidMessages.mmdImportInvalid(),
        },
};
