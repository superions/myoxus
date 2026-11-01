// SPDX-License-Identifier: AGPL-3.0-or-later
export {
  parseMindmapXml,
  MindmapXmlError,
  MINDMAP_XML_LIMITS,
  type MindmapXmlLimits,
  type MindmapXmlFormat,
  type MindmapXmlLoss,
  type MindmapXmlImport,
  type MindmapXmlErrorCode,
  type ForeignMindmapNode,
} from "./parse-xml.js";

import {
  parseMindmapXml as parseXml,
  type MindmapXmlImport,
  type ForeignMindmapNode,
} from "./parse-xml.js";
import { prepareMindmapTree } from "../source-tree.js";

/** Construct one checked import candidate; the caller supplies the bound native
 * maxTextSize, not an attachment budget or a made-up import-only Source limit. */
export function prepareMindmapXmlImport(content: string, maxTextSize: number) {
  return prepareForeignMindmap(parseXml(content), maxTextSize);
}
export function prepareForeignMindmap(
  parsed: MindmapXmlImport,
  maxTextSize: number,
) {
  const prepared = prepareMindmapTree(parsed.root, maxTextSize);
  const entries: Array<{ node: ForeignMindmapNode; parent: number }> = [];
  const pending = [{ node: parsed.root, parent: -1 }];
  while (pending.length) {
    const current = pending.pop()!,
      index = entries.length;
    entries.push(current);
    for (let i = current.node.children.length - 1; i >= 0; i--)
      pending.push({ node: current.node.children[i], parent: index });
  }
  // POSITION outside a root branch has no projection counterpart. Keep that
  // loss explicit even though the XML parser correctly retained the field.
  const losses = parsed.losses.map((loss) => ({ ...loss }));
  const unmappedSides = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.parent !== 0 && entry.node.layoutType);
  if (unmappedSides.length) {
    const previous = losses.find(
      (loss) => loss.kind === "attribute" && loss.field === "POSITION",
    );
    if (previous) previous.count += unmappedSides.length;
    else
      losses.push({
        kind: "attribute",
        field: "POSITION",
        count: unmappedSides.length,
        firstNode: unmappedSides[0].index + 1,
      });
  }
  return {
    ...parsed,
    losses,
    ...prepared,
  };
}
export type PreparedMindmapImport = ReturnType<typeof prepareForeignMindmap>;
