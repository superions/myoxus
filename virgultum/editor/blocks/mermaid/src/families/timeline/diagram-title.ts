// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseTimelineSource,
  applyTimelineCommand,
} from "../../engine/timeline/index.js";
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";

function bodyTitles(source: string) {
  return parseTimelineSource(source)
    .metadata.filter((item) => item.field === "title" && item.format === "body")
    .map((item) => ({
      range: { start: item.range.start, end: item.range.end },
      value: item.value,
    }));
}
export const mermaidTimelineDiagramTitle: MermaidFamilyDiagramTitleHook = {
  patch: (source, type, title) => {
    if (type !== "timeline" || !bodyTitles(source).length) return null;
    const result = applyTimelineCommand(
      parseTimelineSource(source),
      { type: "metadata", field: "title", value: title },
      { baseSource: source, readonly: false },
    );
    return result.changed ? result.source : null;
  },
  resolve: (source, type) =>
    type === "timeline" ? (bodyTitles(source).at(-1) ?? null) : null,
  resolveAll: (source, type) => (type === "timeline" ? bodyTitles(source) : []),
};
