// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";
import { parseMermaidC4Source } from "../../engine/c4/index.js";
import { scanC4Source } from "../../engine/c4/source-document.js";

/** Native C4 title values include %% and may follow a newline separator.
 * Only the scanner's actual value range belongs to the global title edit. */
const c4Titles: MermaidFamilyDiagramTitleHook["resolveAll"] = (source, type) =>
  type === "c4"
    ? scanC4Source(source)
        .records.filter((r) => r.kind === "title")
        .map((r) => ({
          value: r.value ?? "",
          range: { start: r.range.start, end: r.range.end + r.eol.length },
        }))
    : [];
export const c4DiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: c4Titles,
  resolve: (source, type) => c4Titles(source, type).at(-1) ?? null,
  patch(source, type, title) {
    if (type !== "c4" || !parseMermaidC4Source(source)) return null;
    const record = scanC4Source(source).records.findLast(
      (r) => r.kind === "title",
    );
    if (!record?.valueRange) return null;
    const candidate =
      source.slice(0, record.valueRange.start) +
      title +
      source.slice(record.valueRange.end);
    return parseMermaidC4Source(candidate)?.title === title ? candidate : null;
  },
};
