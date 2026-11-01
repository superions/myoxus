// SPDX-License-Identifier: AGPL-3.0-or-later

import { writeMermaidDiagramTitle } from "../../../diagram-title.js";
import type { SankeyModel } from "../model.js";
import { sankeyNoChange, sankeyPatchedResult } from "../writer.js";

export type SankeyMetadataCommand = {
  readonly type: "diagram.title";
  readonly title: string;
};

export function applySankeyMetadataCommand(
  model: SankeyModel,
  command: SankeyMetadataCommand,
) {
  const source = model.sourceDocument.source;
  const next = writeMermaidDiagramTitle({
    diagramType: "sankey",
    source,
    title: command.title,
  });
  if (next === null) return sankeyNoChange(model, "title-invalid");
  if (next === source) return sankeyNoChange(model, "no-change");
  let start = 0;
  while (
    start < source.length &&
    start < next.length &&
    source[start] === next[start]
  )
    start++;
  let end = source.length;
  let nextEnd = next.length;
  while (
    end > start &&
    nextEnd > start &&
    source[end - 1] === next[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  return sankeyPatchedResult(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    null,
  );
}
