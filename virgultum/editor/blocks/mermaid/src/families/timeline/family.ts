// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseTimelineSource,
  type MermaidTimelineModel,
  type TimelineDiagnostic,
} from "../../engine/timeline/index.js";
import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { mermaidTimelineEmbeddedActions } from "./edgeless-actions.js";

export function timelineDiagnosticMessage(item: TimelineDiagnostic) {
  const syntax = {
    header: "timeline LR | timeline TD",
    period: "P",
    event: ": E",
    section: "section S",
    accessibility: "accTitle: | accDescr: | accDescr {…}",
    config: "config.timeline | init.timeline",
    conflict: "Source",
    target: "P | : E | section S",
    readonly: "Source",
  }[item.code];
  return mermaidMessages.timelineDiagnostic(
    syntax,
    item.range.start,
    item.range.end,
    item.range.line,
  );
}

export function timelineFamilyDiagnostics(model: MermaidTimelineModel) {
  return model.diagnostics.map((item) => ({
    code: item.code,
    message: timelineDiagnosticMessage(item),
    severity: "error" as const,
  }));
}
export const mermaidTimelineFamily: MermaidFamilyModule<
  MermaidTimelineModel,
  MermaidTimelineModel
> = {
  applyVisualToSource: (_model, source) => ({
    source,
    diagnostics: [
      {
        code: "timeline.command-required",
        message: mermaidMessages.visualMutationOwnerUnavailable("Timeline"),
        severity: "error",
      },
    ],
  }),
  commands: mermaidTimelineEmbeddedActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId.endsWith(".add") ? "create" : "edit",
  })),
  diagramTypes: ["timeline"],
  id: "timeline",
  inspector: [],
  materializeFrame: () => undefined,
  parseSource: (source, type) => {
    const model = type === "timeline" ? parseTimelineSource(source) : null;
    return {
      diagnostics: model ? timelineFamilyDiagnostics(model) : [],
      diagramType: "timeline",
      model,
      source,
    };
  },
  readFrame: () => null,
  toolbar: mermaidTimelineEmbeddedActions,
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
