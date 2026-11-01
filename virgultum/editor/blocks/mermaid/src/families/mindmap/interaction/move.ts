// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";

import {
  mindmapSubtree,
  type MermaidMindmapModel,
} from "../../../engine/mindmap/index.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import type { MindmapAction } from "../actions.js";

export type MindmapMoveAction = Extract<MindmapAction, { type: "move" }>;
export type MindmapMoveImpact = {
  nodes: number;
  comments: number;
  decorations: number;
  parent: string;
};

/** Pointer and form name the same Source occurrences, never visual neighbours. */
export function mindmapMoveAtAnchor(
  model: MermaidMindmapModel,
  key: string,
  parentKey: string,
  anchorKey?: string,
  position: "before" | "after" = "before",
): MindmapMoveAction | null {
  const tree = mindmapSubtree(model, key),
    parent = model.nodes.find((n) => n.sourceKey === parentKey);
  if (
    !tree ||
    tree.root.root ||
    !parent ||
    tree.nodes.some((n) => n.sourceKey === parentKey)
  )
    return null;
  const siblings = model.nodes.filter(
    (n) => n.parentId === parent.id && n.sourceKey !== key,
  );
  const index = siblings.findIndex((n) => n.sourceKey === anchorKey);
  if (anchorKey && index < 0) return null;
  return {
    type: "move",
    key,
    parentKey,
    beforeKey: anchorKey
      ? siblings[index + (position === "after" ? 1 : 0)]?.sourceKey
      : undefined,
  };
}

export function mindmapMoveImpact(
  model: MermaidMindmapModel,
  action: MindmapMoveAction,
): MindmapMoveImpact | null {
  const tree = mindmapSubtree(model, action.key),
    parent = model.nodes.find((n) => n.sourceKey === action.parentKey);
  if (!tree || !parent) return null;
  return {
    nodes: tree.nodes.length,
    comments: tree.records.filter((r) => r.kind === "comment").length,
    decorations: tree.records.filter(
      (r) => r.kind === "icon" || r.kind === "class",
    ).length,
    parent: parent.label,
  };
}

/** A side-only change is projection history; the checked Source result may be a no-op. */
export function mindmapMoveProjectionOptions(
  visual: MermaidVisualModel,
  model: MermaidMindmapModel,
  action: MindmapMoveAction,
  sourceChanged: boolean,
) {
  const options = { ...readMindmapProjectionOptions(visual) };
  if (sourceChanged) {
    // A checked move must reveal its accepted selection, including form targets
    // inside a collapsed branch. Other collapsed subtrees retain their state.
    const collapsed = new Set(options.collapsed);
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    let parent = model.nodes.find(
      (node) => node.sourceKey === action.parentKey,
    );
    while (parent) {
      collapsed.delete(parent.sourceKey);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    options.collapsed = collapsed;
  }
  if (
    action.side === undefined ||
    !model.nodes.find((n) => n.sourceKey === action.parentKey)?.root
  )
    return { options, changed: false };
  const layout = action.balanced ? LayoutType.BALANCE : options.layout;
  const changed =
    layout === LayoutType.BALANCE &&
    (layout !== options.layout ||
      options.rootSides?.get(action.key) !== action.side);
  return {
    options:
      sourceChanged || changed
        ? {
            ...options,
            layout,
            rootSides: new Map(options.rootSides).set(action.key, action.side),
          }
        : options,
    changed,
  };
}

export function mindmapMoveChoices(
  model: MermaidMindmapModel,
  key: string,
  parentKey: string,
) {
  const tree = mindmapSubtree(model, key);
  const excluded = new Set(tree?.nodes.map((n) => n.sourceKey));
  const parent = model.nodes.find((n) => n.sourceKey === parentKey);
  const lines = new Map(
    model.sourceDocument.records
      .filter((r) => r.kind === "node")
      .map((r) => [r.sourceKey, r.range.line]),
  );
  const option = (node: MermaidMindmapModel["nodes"][number]) => ({
    value: node.sourceKey,
    // Source line disambiguates equal labels without exposing identity keys.
    label: `${lines.get(node.sourceKey)} · ${node.label}`,
  });
  return {
    parents: model.nodes.filter((n) => !excluded.has(n.sourceKey)).map(option),
    anchors: model.nodes
      .filter((n) => n.parentId === parent?.id && n.sourceKey !== key)
      .map(option),
  };
}
