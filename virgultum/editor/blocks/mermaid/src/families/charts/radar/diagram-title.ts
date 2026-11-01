// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidRadarSource } from "../../../engine/charts/radar/parser.js";
import type { MermaidFamilyDiagramTitleHook } from "../../runtime/contracts.js";
import { applyMermaidRadarFamilySourceCommand } from "./source-application.js";

function allRadarBodyTitles(source: string) {
  const model = parseMermaidRadarSource(source);
  if (!model) return [];
  return model.sourceDocument.records.flatMap((record) =>
    record.kind === "metadata" && record.field === "title" && record.valid
      ? [
          {
            range: { end: record.range.end, start: record.range.start },
            value: source
              .slice(record.valueRange.start, record.valueRange.end)
              .trim(),
          },
        ]
      : [],
  );
}

export const mermaidRadarDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, diagramType, title) => {
    if (diagramType !== "radar") return null;
    const model = parseMermaidRadarSource(source);
    if (!model || allRadarBodyTitles(source).length === 0) return null;
    const result = applyMermaidRadarFamilySourceCommand({
      baseSourceHash: model.sourceHash,
      command: { title, type: "diagram.title" },
      model,
      source,
    });
    return result.changed ? result.source : null;
  },
  resolve: (source, diagramType) =>
    diagramType === "radar"
      ? (allRadarBodyTitles(source).at(-1) ?? null)
      : null,
  resolveAll: (source, diagramType) =>
    diagramType === "radar" ? allRadarBodyTitles(source) : [],
};
