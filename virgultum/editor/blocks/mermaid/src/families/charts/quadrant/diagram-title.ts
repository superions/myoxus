// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidQuadrantSource } from "../../../engine/charts/quadrant/parser.js";
import { applyMermaidQuadrantSourceCommand } from "../../../engine/charts/quadrant/writer.js";
import type {
  MermaidFamilyDiagramTitleHook,
  MermaidNativeDiagramTitle,
} from "../../runtime/contracts.js";

function allQuadrantTitles(source: string): MermaidNativeDiagramTitle[] {
  const model = parseMermaidQuadrantSource(source);
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

export const mermaidQuadrantDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, diagramType, title) => {
    if (diagramType !== "quadrantChart") return null;
    const model = parseMermaidQuadrantSource(source);
    if (!model) return null;
    const result = applyMermaidQuadrantSourceCommand({
      baseSourceHash: model.sourceHash,
      command: { title, type: "diagram.title" },
      previousModel: model,
      source,
    });
    return result.changed ? result.source : null;
  },
  resolve: (source, diagramType) => {
    if (diagramType !== "quadrantChart") return null;
    const title = allQuadrantTitles(source).at(-1);
    if (title) return title;
    const model = parseMermaidQuadrantSource(source);
    const header = model?.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    return header
      ? { range: { end: header.range.end, start: header.range.end }, value: "" }
      : null;
  },
  resolveAll: (source, diagramType) =>
    diagramType === "quadrantChart" ? allQuadrantTitles(source) : [],
};
