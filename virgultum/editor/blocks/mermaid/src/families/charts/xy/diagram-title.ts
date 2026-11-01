// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  decodeMermaidXyText,
  parseMermaidXySource,
} from "../../../engine/charts/xy/parser.js";
import { applyMermaidXySourceCommand } from "../../../engine/charts/xy/writer.js";
import type {
  MermaidFamilyDiagramTitleHook,
  MermaidNativeDiagramTitle,
} from "../../runtime/contracts.js";

function allXyTitles(source: string): MermaidNativeDiagramTitle[] {
  const model = parseMermaidXySource(source);
  if (!model) return [];
  return model.sourceDocument.records.flatMap((record) =>
    record.kind === "metadata" && record.field === "title" && record.valid
      ? [
          {
            range: { end: record.range.end, start: record.range.start },
            value: decodeMermaidXyText(
              source.slice(record.valueRange.start, record.valueRange.end),
            ).text,
          },
        ]
      : [],
  );
}

export const mermaidXyDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, diagramType, title) => {
    if (diagramType !== "xychart") return null;
    const model = parseMermaidXySource(source);
    if (!model) return null;
    const result = applyMermaidXySourceCommand({
      baseSourceHash: model.sourceHash,
      command: { title, type: "diagram.title" },
      previousModel: model,
      source,
    });
    return result.changed ? result.source : null;
  },
  resolve: (source, diagramType) => {
    if (diagramType !== "xychart") return null;
    const title = allXyTitles(source).at(-1);
    if (title) return title;
    const header = parseMermaidXySource(source)?.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    return header
      ? { range: { end: header.range.end, start: header.range.end }, value: "" }
      : null;
  },
  resolveAll: (source, diagramType) =>
    diagramType === "xychart" ? allXyTitles(source) : [],
};
