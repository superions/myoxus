// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidPieSource } from "../../../engine/charts/pie/parser.js";
import { applyMermaidPieSourceCommand } from "../../../engine/charts/pie/writer.js";
import type {
  MermaidFamilyDiagramTitleHook,
  MermaidNativeDiagramTitle,
} from "../../runtime/contracts.js";

function resolveAllPieTitles(source: string): MermaidNativeDiagramTitle[] {
  const model = parseMermaidPieSource(source);
  if (!model) return [];
  return model.sourceDocument.records.flatMap((record) =>
    record.kind === "metadata" &&
    record.field === "title" &&
    record.format === "body" &&
    record.valid
      ? [
          {
            range: { end: record.range.end, start: record.range.start },
            value: source
              .slice(record.valueRange.start, record.valueRange.end)
              .trim()
              .replace(/[\t ]{2,}/g, " "),
          },
        ]
      : [],
  );
}

function resolvePieTitle(source: string): MermaidNativeDiagramTitle | null {
  const titles = resolveAllPieTitles(source);
  const existing = titles.at(-1);
  if (existing) return existing;
  const model = parseMermaidPieSource(source);
  const header = model?.sourceDocument.records.find(
    (record) => record.kind === "header",
  );
  return header
    ? {
        range: { end: header.range.end, start: header.range.end },
        value: "",
      }
    : null;
}

export const mermaidPieDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, diagramType, title) => {
    if (diagramType !== "pie") return null;
    const model = parseMermaidPieSource(source);
    if (!model) return null;
    const result = applyMermaidPieSourceCommand({
      baseSourceHash: model.sourceHash,
      command: { title, type: "diagram.title" },
      previousModel: model,
      source,
    });
    return result.changed ? result.source : null;
  },
  resolve: (source, diagramType) =>
    diagramType === "pie" ? resolvePieTitle(source) : null,
  resolveAll: (source, diagramType) =>
    diagramType === "pie" ? resolveAllPieTitles(source) : [],
};
