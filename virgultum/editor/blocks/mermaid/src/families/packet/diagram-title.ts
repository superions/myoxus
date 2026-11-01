// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidPacketSource,
  writePacketPatches,
} from "../../engine/packet/index.js";
import type { MermaidFamilyDiagramTitleHook } from "../runtime/contracts.js";

/** Titles are actual Packet records. Line matching would mistake text inside a
 * multiline accDescr or quoted field label for a title declaration. */
export const mermaidPacketDiagramTitle: MermaidFamilyDiagramTitleHook = {
  resolveAll: (source, type) =>
    type === "packet"
      ? (parseMermaidPacketSource(source)?.sourceDocument.records ?? [])
          .filter((record) => record.kind === "title")
          .map((record) => ({
            range: {
              start: record.range.start,
              end: record.range.end + record.eol.length,
            },
            value: record.raw.slice(record.indent.length + 5).trim(),
          }))
      : [],
  resolve: (source, type) =>
    mermaidPacketDiagramTitle.resolveAll(source, type).at(-1) ?? null,
  patch: (source, type, title) => {
    if (type !== "packet" || /[\r\n]/.test(title) || title.includes("%%"))
      return null;
    const model = parseMermaidPacketSource(source);
    const record = model?.sourceDocument.records.findLast(
      (record) => record.kind === "title",
    );
    if (!model || !record) return null;
    const value = record.raw.slice(record.indent.length + 5);
    const leading = /^[ \t]*/.exec(value)![0].length;
    const trailing = /[ \t]*$/.exec(value)![0].length;
    const start = record.range.start + record.indent.length + 5 + leading;
    const end = Math.max(start, record.range.end - trailing);
    const result = writePacketPatches(model, [
      { range: { start, end }, value: title },
    ]);
    return result.changed || result.reason === "no-change"
      ? result.source
      : null;
  },
};
