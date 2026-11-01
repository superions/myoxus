// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidStateModel,
  MermaidStateNode,
  MermaidStateComposite,
} from "../../engine/state/index.js";
import type { StateConfig } from "../../engine/state/config.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import type {
  MermaidVisualEdge,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { mermaidGraphLayers } from "../runtime/graph-layout.js";

export { stateDisplayText } from "../../engine/state/index.js";
import {
  stateDisplayText,
  stateEffectiveDescriptions,
  stateCompositeBodyKeys,
} from "../../engine/state/index.js";
export function stateTypography(
  config: StateConfig,
  styles: Readonly<Record<string, string>>,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    fontSize = parseFloat(styles["font-size"] ?? "") || config.fontSize;
  return {
    ...theme.typography,
    fontSize,
    lineHeight:
      (theme.typography.lineHeight * fontSize) / theme.typography.fontSize,
    fontFamily: styles["font-family"] ?? theme.typography.fontFamily,
    fontWeight: styles["font-weight"] ?? theme.typography.fontWeight,
    fontStyle: styles["font-style"] ?? theme.typography.fontStyle,
  };
}
export function stateContentMetrics(
  node: MermaidStateNode | MermaidStateComposite,
  config: StateConfig,
  styles: Readonly<Record<string, string>>,
) {
  const type = stateTypography(config, styles),
    padding = config.padding;
  if ("kind" in node && node.kind !== "state") {
    const terminal = node.kind === "start" || node.kind === "end",
      branch = node.kind === "fork" || node.kind === "join";
    return {
      fontSize: type.fontSize,
      padding: 0,
      headerHeight: 0,
      rows: [],
      width: branch
        ? config.forkWidth
        : terminal
          ? config.sizeUnit * (node.kind === "end" ? 5 : 4)
          : config.sizeUnit * 8,
      height: branch
        ? config.forkHeight
        : terminal
          ? config.sizeUnit * (node.kind === "end" ? 5 : 4)
          : config.sizeUnit * 8,
    };
  }
  const heading = measureMermaidGfxText(stateDisplayText(node.label), type),
    headerHeight = heading.height + padding * 2;
  let width = heading.width + padding * 2,
    height = headerHeight;
  const rows = stateEffectiveDescriptions(node)
    .slice(1)
    .map((d) => {
      const text = measureMermaidGfxText(stateDisplayText(d.text), type),
        row = { key: d.id, y: height + padding, height: text.height };
      height += text.height + padding * 2;
      width = Math.max(width, text.width + padding * 2);
      return row;
    });
  return {
    fontSize: type.fontSize,
    padding,
    headerHeight,
    rows,
    width: Math.max(type.fontSize * 4, width),
    height: Math.max(type.lineHeight + padding * 2, height),
  };
}
export type StateLayoutFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};
/** Recursive Source scopes and concurrency regions use measured bodies. Only
 * cold/explicit placement consumes these ranks; reconciliation owns live XY. */
export function layoutStateHierarchy(
  model: MermaidStateModel,
  input: MermaidVisualNode[],
  edges: readonly MermaidVisualEdge[],
  config: StateConfig,
  styles: (id: string) => Readonly<Record<string, string>>,
) {
  const frames = new Map<string, StateLayoutFrame>(),
    regionFrames = new Map<string, StateLayoutFrame>();
  const objects = [
      ...model.states,
      ...model.composites,
      ...model.notes
        .filter((n) => n.form === "floating")
        .map((n) => ({ ...n, sourceKey: n.id })),
    ],
    byKey = new Map(objects.map((n) => [n.sourceKey!, n]));
  function place(scope: string | undefined): {
    nodes: MermaidVisualNode[];
    width: number;
    height: number;
  } {
    const owner = model.composites.find((c) => c.id === scope),
      groups = model.composites.filter((c) => c.parentId === scope),
      descendants = new Map(groups.map((g) => [g.id, place(g.id)]));
    const regions = [
      ...(owner ? stateCompositeBodyKeys(model, owner) : [null]),
      ...model.regions.filter((r) => r.compositeId === scope).map((r) => r.id),
    ].sort((a, b) => {
      const record = (key: string | null) =>
        model.sourceDocument.records.find(
          (r) => r.sourceKey === key || `${r.sourceKey}:region` === key,
        )?.range.start ?? 0;
      return record(a) - record(b);
    });
    const header = owner
      ? stateContentMetrics(owner, config, styles(owner.id))
      : null;
    const pad = owner ? config.padding + config.dividerMargin : config.padding,
      top = header ? header.height + config.dividerMargin : config.padding;
    const result: MermaidVisualNode[] = [];
    let bottom = top,
      right = header?.width ?? config.fontSize * 4;
    for (const region of regions) {
      const direct = input.filter((n) => {
        const object = byKey.get(n.id);
        return (
          object &&
          object.parentId === scope &&
          (object.regionKey ?? null) === region
        );
      });
      const children = groups.filter((g) => (g.regionKey ?? null) === region);
      const boxes: MermaidVisualNode[] = [
        ...direct,
        ...children.map((g) => ({
          id: g.sourceKey!,
          label: g.label,
          shape: "rect" as const,
          x: 0,
          y: 0,
          width: descendants.get(g.id)!.width,
          height: descendants.get(g.id)!.height,
        })),
      ].sort((a, b) => byKey.get(a.id)!.order - byKey.get(b.id)!.order);
      const bodies = new Map(
        boxes.map((b) => [b.id, { width: b.width, height: b.height }]),
      );
      const attached = new Map(
        boxes.map((b) => {
          const sourceId = byKey.get(b.id)!.id;
          const note = model.notes.find(
            (n) => n.effective && n.stateId === sourceId,
          );
          const projected = note && input.find((n) => n.id === note.id);
          return [
            b.id,
            projected && note
              ? { node: projected, side: note.placement }
              : null,
          ] as const;
        }),
      );
      for (const box of boxes) {
        const note = attached.get(box.id);
        if (note) {
          box.width += note.node.width + config.noteMargin;
          box.height = Math.max(box.height, note.node.height);
        }
      }
      const rootFor = (key: string) => {
        let node = byKey.get(key);
        const visited = new Set<string>();
        while (node && !visited.has(node.id)) {
          visited.add(node.id);
          if (node.parentId === scope)
            return boxes.some((b) => b.id === node!.sourceKey)
              ? node.sourceKey
              : undefined;
          node = model.composites.find((c) => c.id === node!.parentId);
        }
        return undefined;
      };
      const relations = edges.flatMap((e) => {
        const from = rootFor(e.source),
          to = rootFor(e.target);
        return from && to && from !== to
          ? [{ source: from, target: to, label: e.label }]
          : [];
      });
      const direction = owner?.direction ?? (owner ? "TB" : model.direction),
        horizontal = direction === "LR" || direction === "RL",
        reverse = direction === "RL" || direction === "BT",
        layers = mermaidGraphLayers(boxes, relations),
        max = Math.max(0, ...layers.values()),
        ranks = new Map<number, MermaidVisualNode[]>();
      for (const box of boxes) {
        const rank = reverse
          ? max - (layers.get(box.id) ?? 0)
          : (layers.get(box.id) ?? 0);
        ranks.set(rank, [...(ranks.get(rank) ?? []), box]);
      }
      const type = stateTypography(config, {}),
        gap = Math.max(
          config.rankSpacing,
          ...relations.map((e) => {
            const text = measureMermaidGfxText(stateDisplayText(e.label), type);
            return (
              (horizontal ? text.width : text.height) + type.lineHeight * 2
            );
          }),
        );
      let primaryOffset = 0,
        regionHeight = type.lineHeight + config.padding * 2;
      const positions = new Map<string, StateLayoutFrame>();
      for (const [, rank] of [...ranks.entries()].sort(([a], [b]) => a - b)) {
        let cross = 0;
        for (const box of rank) {
          const x = pad + (horizontal ? primaryOffset : cross),
            y = bottom + (horizontal ? cross : primaryOffset);
          positions.set(box.id, { x, y, width: box.width, height: box.height });
          cross += (horizontal ? box.height : box.width) + config.nodeSpacing;
          right = Math.max(right, x + box.width + pad);
          regionHeight = Math.max(regionHeight, y + box.height - bottom + pad);
        }
        primaryOffset +=
          Math.max(...rank.map((b) => (horizontal ? b.width : b.height))) + gap;
      }
      if (region)
        regionFrames.set(region, {
          x: pad,
          y: bottom,
          width: right - pad * 2,
          height: regionHeight,
        });
      for (const box of boxes) {
        const cluster = positions.get(box.id)!,
          note = attached.get(box.id),
          size = bodies.get(box.id)!;
        const position = {
            ...cluster,
            ...size,
            x:
              cluster.x +
              (note?.side === "left of"
                ? note.node.width + config.noteMargin
                : 0),
          },
          group = children.find((g) => g.sourceKey === box.id);
        if (note)
          result.push({
            ...note.node,
            x:
              note.side === "left of"
                ? cluster.x
                : position.x + size.width + config.noteMargin,
            y: position.y,
          });
        if (!group) {
          result.push({ ...box, ...position });
          continue;
        }
        const body = descendants.get(group.id)!;
        result.push(
          ...body.nodes.map((n) => ({
            ...n,
            x: n.x + position.x,
            y: n.y + position.y,
          })),
        );
        const contained = descendantCompositeIds(group.id);
        for (const [key, f] of frames)
          if (contained.has(byKey.get(key)?.id ?? ""))
            frames.set(key, { ...f, x: f.x + position.x, y: f.y + position.y });
        for (const [key, f] of regionFrames) {
          const regionOwner =
            model.regions.find((r) => r.id === key)?.compositeId ??
            model.sourceDocument.records.find(
              (r) => `${r.sourceKey}:region` === key && r.kind === "composite",
            )?.ownerId;
          if (regionOwner && contained.has(regionOwner))
            regionFrames.set(key, {
              ...f,
              x: f.x + position.x,
              y: f.y + position.y,
            });
        }
        frames.set(group.sourceKey!, position);
      }
      bottom +=
        regionHeight + (region !== regions.at(-1) ? config.dividerMargin : 0);
    }
    for (const region of regions)
      if (region && regionFrames.has(region))
        regionFrames.set(region, {
          ...regionFrames.get(region)!,
          width: Math.max(0, right - pad * 2),
        });
    return { nodes: result, width: right, height: bottom + pad };
  }
  function descendantCompositeIds(id: string) {
    const ids = new Set([id]);
    let added = true;
    while (added) {
      added = false;
      for (const c of model.composites)
        if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
          ids.add(c.id);
          added = true;
        }
    }
    return ids;
  }
  const root = place(undefined);
  return { nodes: root.nodes, frames, regionFrames };
}
