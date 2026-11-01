// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  parseMermaidMindmapSource,
  serializeMindmapNode,
} from "../../engine/mindmap/index.js";
import { resolveMermaidBlockInsertIdentity } from "../../mermaid-insert-identity.js";
import { projectMindmapTree } from "./projection/tree.js";
import { MindmapLayoutType, type MindmapDesign } from "./projection/options.js";
import {
  copyMindmapSubtrees,
  pasteMindmapSubtrees,
  mindmapSubtree,
  writeMindmapPatches,
  type MermaidMindmapModel,
} from "../../engine/mindmap/index.js";

export type MindmapTreeInput = {
  text: string;
  children: MindmapTreeInput[];
  layoutType?: "left" | "right";
};
/** Shared import/AI preparation creates Source and derived projection only.
 * Its caller supplies the bound native Source budget. No Store is mutated. */
export function prepareMindmapTree(
  root: MindmapTreeInput,
  maxTextSize: number,
  design?: MindmapDesign,
) {
  if (!Number.isFinite(maxTextSize) || maxTextSize < 1)
    throw new Error("source-limit");
  const entries: Array<{
    node: MindmapTreeInput;
    depth: number;
    parent: number;
  }> = [];
  const pending = [{ node: root, depth: 0, parent: -1 }];
  const lines = ["mindmap"];
  const seen = new Set<MindmapTreeInput>();
  let size = 8;
  while (pending.length) {
    const current = pending.pop()!,
      index = entries.length;
    if (seen.has(current.node)) throw new Error("source-tree");
    seen.add(current.node);
    const syntax = serializeMindmapNode({
      label: current.node.text,
      shape: "default",
    });
    if (syntax === null) throw new Error(`source-label:${index + 1}`);
    size += current.depth * 2 + syntax.length + 1;
    if (size > maxTextSize) throw new Error(`source-limit:${maxTextSize}`);
    lines.push("  ".repeat(current.depth) + syntax);
    entries.push(current);
    for (let i = current.node.children.length - 1; i >= 0; i--)
      pending.push({
        node: current.node.children[i],
        depth: current.depth + 1,
        parent: index,
      });
  }
  const body = lines.join("\n") + "\n";
  // Reject before insert-identity parsing can materialize an over-budget Source.
  if (body.length > maxTextSize) throw new Error(`source-limit:${maxTextSize}`);
  const source = resolveMermaidBlockInsertIdentity({ source: body }).source;
  if (source.length > maxTextSize)
    throw new Error(`source-limit:${maxTextSize}`);
  const model = parseMermaidMindmapSource(source);
  if (
    !model ||
    model.nodes.length !== entries.length ||
    entries.some(
      (entry, i) =>
        model.nodes[i].label !== entry.node.text ||
        model.nodes[i].parentId !==
          (entry.parent < 0 ? null : model.nodes[entry.parent].id),
    )
  )
    throw new Error("source-structure");
  const rootSides = new Map<
    string,
    MindmapLayoutType.LEFT | MindmapLayoutType.RIGHT
  >();
  for (const [index, entry] of entries.entries())
    if (entry.parent === 0 && entry.node.layoutType)
      rootSides.set(
        model.nodes[index].sourceKey,
        entry.node.layoutType === "left"
          ? MindmapLayoutType.LEFT
          : MindmapLayoutType.RIGHT,
      );
  return {
    source,
    model,
    maxTextSize,
    rootSides,
    visualModel: projectMindmapTree(model, {
      layout: rootSides.size
        ? MindmapLayoutType.BALANCE
        : MindmapLayoutType.RIGHT,
      rootSides,
      design,
    }),
  };
}
export type PreparedMindmapTree = ReturnType<typeof prepareMindmapTree>;

/** Replace the accepted tree or append its children using the normal checked
 * writer. The existing owner's preamble/header stay authoritative. */
export function prepareMindmapTreeUpdate(
  base: MermaidMindmapModel,
  candidate: PreparedMindmapTree,
  parentKey: string,
  replace: boolean,
) {
  if (!replace) {
    const root = candidate.model.nodes[0];
    const keys = candidate.model.nodes
      .filter((node) => node.parentId === root.id)
      .map((node) => node.sourceKey);
    const copies = copyMindmapSubtrees(candidate.model, keys);
    return copies ? pasteMindmapSubtrees(base, parentKey, copies) : null;
  }
  const target = mindmapSubtree(base, parentKey);
  if (!target?.root.root) return null;
  const copy = copyMindmapSubtrees(candidate.model, [
    candidate.model.nodes[0].sourceKey,
  ])?.[0];
  if (!copy) return null;
  const offset = copy.source.indexOf("\n") + 1;
  return writeMindmapPatches(base, [
    {
      start: target.start,
      end: target.end,
      text: copy.source.slice(offset),
      identities: copy.identities.map(
        ([start, key]) => [start - offset, key] as const,
      ),
    },
  ]);
}

/** Explicit tree/AI context, not the document Markdown adapter. Retain authored
 * decoration rows with their owning occurrence; normal export keeps exact MMD. */
export function mindmapSourceOutline(model: MermaidMindmapModel) {
  const decorations = new Map<string, string[]>();
  for (const record of model.sourceDocument.records) {
    if (
      !record.anchorKey ||
      (record.kind !== "icon" && record.kind !== "class")
    )
      continue;
    const rows = decorations.get(record.anchorKey) ?? [];
    rows.push(record.raw.trimStart());
    decorations.set(record.anchorKey, rows);
  }
  const rootDepth = model.nodes[0]?.depth ?? 0;
  return model.nodes
    .map((node) => {
      const indent = "  ".repeat(node.depth - rootDepth);
      const label = node.label.replaceAll("\n", "\n" + indent + "  ");
      return (
        `${indent}- ${label}\n` +
        (decorations.get(node.sourceKey) ?? [])
          .map((row) => `${indent}  ${row}\n`)
          .join("")
      );
    })
    .join("");
}
