// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseTreemapSource } from "../../../engine/charts/treemap/parser.js";
import type { MermaidFamilyDiagramTitleHook } from "../../runtime/contracts.js";
import { applyMermaidTreemapFamilySourceCommand } from "./source-application.js";

function bodyTitles(source: string) {
  const model = parseTreemapSource(source);
  if (!model) return [];
  return model.sourceDocument.records.flatMap((record) =>
    record.kind === "title"
      ? [
          {
            range: { start: record.range.start, end: record.range.end },
            value: record.raw
              .trim()
              .replace(/^title\s*/i, "")
              .trim(),
          },
        ]
      : [],
  );
}

export const mermaidTreemapDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, diagramType, title) => {
    if (diagramType !== "treemap" || bodyTitles(source).length === 0)
      return null;
    const model = parseTreemapSource(source);
    if (!model) return null;
    const result = applyMermaidTreemapFamilySourceCommand({
      model,
      source,
      readonly: false,
      command: { type: "metadata.set", field: "title", value: title },
    });
    return result.changed ? result.source : null;
  },
  resolve: (source, diagramType) =>
    diagramType === "treemap" ? (bodyTitles(source).at(-1) ?? null) : null,
  resolveAll: (source, diagramType) =>
    diagramType === "treemap" ? bodyTitles(source) : [],
};
