// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidGanttSource } from "../../engine/gantt/parser.js";
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";
import { applyMermaidGanttFamilySourceCommand } from "./source-application.js";

function bodyTitles(source: string) {
  const model = parseMermaidGanttSource(source);
  if (!model) return [];
  return model.sourceDocument.statements.flatMap((statement) =>
    statement.kind === "title"
      ? [
          {
            range: {
              end: statement.range.end,
              start: statement.range.start,
            },
            value: statement.raw
              .trim()
              .replace(/^title\s*/i, "")
              .trim(),
          },
        ]
      : [],
  );
}

export const mermaidGanttDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, diagramType, title) => {
    if (diagramType !== "gantt" || bodyTitles(source).length === 0) return null;
    const model = parseMermaidGanttSource(source);
    if (!model) return null;
    const result = applyMermaidGanttFamilySourceCommand({
      command: { field: "title", type: "metadata.set", value: title },
      model,
      readonly: false,
      source,
    });
    return result.changed ? result.source : null;
  },
  resolve: (source, diagramType) =>
    diagramType === "gantt" ? (bodyTitles(source).at(-1) ?? null) : null,
  resolveAll: (source, diagramType) =>
    diagramType === "gantt" ? bodyTitles(source) : [],
};
