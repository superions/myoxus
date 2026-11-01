// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidMindmapModel, MermaidMindmapNode } from "../model.js";
import type { MindmapRecord } from "../source-document.js";
import { parseMermaidMindmapSource } from "../parser.js";
import {
  unchangedMindmap,
  writeMindmapPatches,
  type MindmapCommandOptions,
} from "../writer.js";

export function mindmapNodeRecord(model: MermaidMindmapModel, key: string) {
  return model.sourceDocument.records.find(
    (r) => r.kind === "node" && r.sourceKey === key,
  );
}

/** Source order is preorder. The subtree owns complete records through the next
 * non-descendant node; multiline label interiors are never indentation targets. */
export function mindmapSubtree(model: MermaidMindmapModel, key: string) {
  const index = model.nodes.findIndex((n) => n.sourceKey === key);
  if (index < 0) return undefined;
  const root = model.nodes[index],
    nodes = [root];
  let endIndex = index + 1;
  while (
    endIndex < model.nodes.length &&
    model.nodes[endIndex].depth > root.depth
  )
    nodes.push(model.nodes[endIndex++]);
  const first = mindmapNodeRecord(model, key)!;
  const end =
    endIndex < model.nodes.length
      ? mindmapNodeRecord(model, model.nodes[endIndex].sourceKey)!.range.start
      : model.sourceDocument.source.length;
  return {
    root,
    nodes,
    start: first.range.start,
    end,
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= first.range.start && r.range.start < end,
    ),
  };
}

export function mindmapNativeIndent(model: MermaidMindmapModel, key: string) {
  const record = mindmapNodeRecord(model, key)!;
  return record.nativeIndent ?? record.indent;
}

export function mindmapChildIndent(
  model: MermaidMindmapModel,
  parent: MermaidMindmapNode,
  excludedKey?: string,
) {
  const record = mindmapNodeRecord(model, parent.sourceKey)!;
  const existing = model.nodes.find(
    (n) => n.parentId === parent.id && n.sourceKey !== excludedKey,
  );
  return existing
    ? mindmapNativeIndent(model, existing.sourceKey)
    : (record.nativeIndent ?? record.indent) + "  ";
}

function shiftedSubtree(
  model: MermaidMindmapModel,
  records: MindmapRecord[],
  start: number,
  end: number,
  oldIndent: string,
  indent: string,
) {
  const source = model.sourceDocument.source;
  let text = "",
    cursor = start;
  const identities: Array<readonly [number, string]> = [];
  const localKeys = new Set(records.map((record) => record.sourceKey));
  const providers = new Set(
    records.flatMap((record) =>
      record.indentProviderKey ? [record.indentProviderKey] : [],
    ),
  );
  for (const record of records) {
    text += source.slice(cursor, record.range.start);
    identities.push([text.length, record.sourceKey]);
    if (record.kind === "node" || providers.has(record.sourceKey)) {
      text +=
        (record.indentProviderKey && localKeys.has(record.indentProviderKey)
          ? record.indent
          : indent + record.indent.slice(oldIndent.length)) +
        source.slice(
          record.range.start + record.indent.length,
          record.range.end + record.eol.length,
        );
    } else text += record.raw + record.eol;
    cursor = record.range.end + record.eol.length;
  }
  text += source.slice(cursor, end);
  return { text, identities };
}

export function moveMindmapSubtree(
  model: MermaidMindmapModel,
  key: string,
  parentKey: string,
  beforeKey?: string,
  options: MindmapCommandOptions = {},
) {
  const subtree = mindmapSubtree(model, key),
    parent = model.nodes.find((n) => n.sourceKey === parentKey);
  if (!subtree || !parent) return unchangedMindmap(model, "selection");
  if (subtree.root.root || subtree.nodes.some((n) => n.sourceKey === parentKey))
    return unchangedMindmap(model, "tree");
  const before = beforeKey
    ? model.nodes.find((n) => n.sourceKey === beforeKey)
    : undefined;
  if (beforeKey && (!before || before.parentId !== parent.id))
    return unchangedMindmap(model, "tree");
  if (beforeKey === key) return unchangedMindmap(model);
  const parentSubtree = mindmapSubtree(model, parentKey)!;
  const target = before
    ? mindmapNodeRecord(model, before.sourceKey)!.range.start
    : parentSubtree.end;
  if (
    (target === subtree.start || target === subtree.end) &&
    subtree.root.parentId === parent.id
  )
    return unchangedMindmap(model);
  if (target > subtree.start && target < subtree.end)
    return unchangedMindmap(model, "tree");
  const indent =
    subtree.root.parentId === parent.id
      ? mindmapNativeIndent(model, key)
      : mindmapChildIndent(model, parent, key);
  const moved = shiftedSubtree(
    model,
    subtree.records,
    subtree.start,
    subtree.end,
    mindmapNativeIndent(model, key),
    indent,
  );
  if (target === subtree.start || target === subtree.end) {
    return writeMindmapPatches(
      model,
      [{ start: subtree.start, end: subtree.end, ...moved }],
      options,
      key,
    );
  }
  // An EOF record may lack NL. Insertion changes only the necessary boundary.
  const nl = model.sourceDocument.newline;
  if (
    target < model.sourceDocument.source.length &&
    !/[\r\n]$/.test(moved.text)
  )
    moved.text += nl;
  const prefix =
    target > 0 && !/[\r\n]/.test(model.sourceDocument.source[target - 1])
      ? nl
      : "";
  return writeMindmapPatches(
    model,
    [
      { start: subtree.start, end: subtree.end, text: "" },
      {
        start: target,
        end: target,
        text: prefix + moved.text,
        identities: moved.identities.map(
          ([offset, identity]) => [offset + prefix.length, identity] as const,
        ),
      },
    ],
    options,
    key,
  );
}

/** Normalize Source occurrences before any collective command: an ancestor owns
 * its descendants exactly once, including hidden records and decorators. */
export function mindmapSelectionSubtrees(
  model: MermaidMindmapModel,
  keys: readonly string[],
) {
  const selected = new Set(keys);
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  if (
    [...selected].some(
      (key) => !model.nodes.some((node) => node.sourceKey === key),
    )
  )
    return null;
  return model.nodes
    .filter((node) => {
      if (!selected.has(node.sourceKey)) return false;
      let parent = node.parentId ? byId.get(node.parentId) : undefined;
      while (parent) {
        if (selected.has(parent.sourceKey)) return false;
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      return true;
    })
    .map((node) => mindmapSubtree(model, node.sourceKey)!);
}

export function deleteMindmapSubtrees(
  model: MermaidMindmapModel,
  keys: readonly string[],
  options: MindmapCommandOptions = {},
) {
  const trees = mindmapSelectionSubtrees(model, keys);
  if (!trees?.length) return unchangedMindmap(model, "selection");
  return writeMindmapPatches(
    model,
    trees.map((tree) => ({ start: tree.start, end: tree.end, text: "" })),
    options,
    model.nodes.find((node) => node.id === trees[0].root.parentId)?.sourceKey,
  );
}

export function deleteMindmapSubtree(
  model: MermaidMindmapModel,
  key: string,
  options: MindmapCommandOptions = {},
) {
  return deleteMindmapSubtrees(model, [key], options);
}

export type MindmapCopiedSubtree = {
  readonly source: string;
  readonly identities: readonly (readonly [number, string])[];
};

/** A clipboard forest contains valid Source trees, with occurrence bindings.
 * Syntax IDs are ordinary Source bytes and may legitimately be repeated. */
export function copyMindmapSubtrees(
  model: MermaidMindmapModel,
  keys: readonly string[],
): MindmapCopiedSubtree[] | null {
  const trees = mindmapSelectionSubtrees(model, keys);
  if (!trees?.length) return null;
  return trees.map((tree) => {
    const prefix = `mindmap${model.sourceDocument.newline}`;
    const shifted = shiftedSubtree(
      model,
      tree.records,
      tree.start,
      tree.end,
      mindmapNativeIndent(model, tree.root.sourceKey),
      "",
    );
    return {
      source: prefix + shifted.text,
      identities: shifted.identities.map(
        ([offset, key]) => [prefix.length + offset, key] as const,
      ),
    };
  });
}

export function readCopiedMindmapSubtree(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("identities" in value) ||
    !Array.isArray(value.identities)
  )
    return null;
  const mapping = new Map<number, string>(),
    keys = new Set<string>();
  for (const pair of value.identities) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !Number.isInteger(pair[0]) ||
      typeof pair[1] !== "string" ||
      !pair[1] ||
      mapping.has(pair[0]) ||
      keys.has(pair[1])
    )
      return null;
    mapping.set(pair[0], pair[1]);
    keys.add(pair[1]);
  }
  const model = parseMermaidMindmapSource(value.source, { mapping });
  if (!model?.nodes.length) return null;
  const records = model.sourceDocument.records.filter(
    (record) => record.kind !== "header",
  );
  if (
    records.length !== mapping.size ||
    records.some(
      (record) => mapping.get(record.range.start) !== record.sourceKey,
    )
  )
    return null;
  return model;
}

/** All insertions are checked together against the target Source. Every copied
 * occurrence receives a fresh key before reconciliation can match equal text. */
export function pasteMindmapSubtrees(
  model: MermaidMindmapModel,
  parentKey: string,
  copies: readonly MindmapCopiedSubtree[],
  options: MindmapCommandOptions = {},
) {
  const parent = model.nodes.find((node) => node.sourceKey === parentKey);
  const trees = copies.map(readCopiedMindmapSubtree);
  const keyMap = new Map<string, string>();
  if (!parent || !trees.length || trees.some((tree) => !tree))
    return { ...unchangedMindmap(model, "selection"), keyMap };
  const target = mindmapSubtree(model, parentKey)!.end;
  const indent = mindmapChildIndent(model, parent);
  let text =
    target && !/[\r\n]/.test(model.sourceDocument.source[target - 1])
      ? model.sourceDocument.newline
      : "";
  const identities: Array<readonly [number, string]> = [];
  let selection: string | undefined;
  for (const tree of trees) {
    const subtree = mindmapSubtree(tree!, tree!.nodes[0].sourceKey)!;
    const copied = shiftedSubtree(
      tree!,
      subtree.records,
      subtree.start,
      subtree.end,
      mindmapNativeIndent(tree!, subtree.root.sourceKey),
      indent,
    );
    for (const [offset, key] of copied.identities) {
      // Repeated source keys across clipboard chunks are malformed, rather than
      // an invitation to alias two copied occurrences in the target owner.
      if (keyMap.has(key))
        return {
          ...unchangedMindmap(model, "selection"),
          keyMap: new Map<string, string>(),
        };
      const fresh = `mindmap-source-${crypto.randomUUID()}`;
      keyMap.set(key, fresh);
      identities.push([text.length + offset, fresh]);
      selection ??= fresh;
    }
    text += copied.text;
    if (!/[\r\n]$/.test(text)) text += model.sourceDocument.newline;
  }
  return {
    ...writeMindmapPatches(
      model,
      [{ start: target, end: target, text, identities }],
      options,
      selection,
    ),
    keyMap,
  };
}

export function duplicateMindmapSubtrees(
  model: MermaidMindmapModel,
  keys: readonly string[],
  options: MindmapCommandOptions = {},
) {
  const trees = mindmapSelectionSubtrees(model, keys),
    keyMap = new Map<string, string>();
  if (!trees?.length || trees.some((tree) => tree.root.root))
    return { ...unchangedMindmap(model, "tree"), keyMap };
  const patches = trees.map((tree) => {
    const copied = shiftedSubtree(
      model,
      tree.records,
      tree.start,
      tree.end,
      mindmapNativeIndent(model, tree.root.sourceKey),
      mindmapNativeIndent(model, tree.root.sourceKey),
    );
    const prefix = !/[\r\n]/.test(model.sourceDocument.source[tree.end - 1])
      ? model.sourceDocument.newline
      : "";
    return {
      start: tree.end,
      end: tree.end,
      text:
        prefix +
        copied.text +
        (/[\r\n]$/.test(copied.text) ? "" : model.sourceDocument.newline),
      identities: copied.identities.map(([offset, key]) => {
        const fresh = `mindmap-source-${crypto.randomUUID()}`;
        keyMap.set(key, fresh);
        return [prefix.length + offset, fresh] as const;
      }),
    };
  });
  return {
    ...writeMindmapPatches(
      model,
      patches,
      options,
      keyMap.get(trees[0].root.sourceKey),
    ),
    keyMap,
  };
}
