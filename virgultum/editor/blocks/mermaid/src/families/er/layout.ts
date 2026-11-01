// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  measureMermaidGfxText,
  mermaidGfxTypographyForNode,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
import type {
  MermaidErModel,
  MermaidErEntity,
  ErConfig,
} from "../../engine/er/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import { mermaidGraphLayers } from "../runtime/graph-layout.js";
import type {
  MermaidVisualEdge,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
/** Header text, reading clearance and complete composite endpoints stay apart. */
export function erSubgraphHeaderMetrics(
  title: string,
  styles: Readonly<Record<string, string>> = {},
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    typography = mermaidGfxTypographyForNode(
      projectMermaidSourceStyle(styles),
      theme,
    ),
    text = measureMermaidGfxText(title, typography);
  return {
    height: Math.max(
      theme.typography.lineHeight * 3 + 36,
      text.height + theme.typography.lineHeight / 2 + 36,
    ),
    width: text.width + theme.typography.lineHeight * 2,
  };
}
export function erEntityMetrics(
  entity: MermaidErEntity,
  config: ErConfig,
  styles: Readonly<Record<string, string>>,
) {
  const theme = resolveMermaidGfxProjectionTheme(),
    fontSize = parseFloat(styles["font-size"] ?? "") || config.fontSize,
    type = {
      ...theme.typography,
      fontSize,
      lineHeight:
        (theme.typography.lineHeight * fontSize) / theme.typography.fontSize,
      fontFamily: styles["font-family"] ?? theme.typography.fontFamily,
      fontWeight: styles["font-weight"] ?? theme.typography.fontWeight,
      fontStyle: styles["font-style"] ?? theme.typography.fontStyle,
    },
    padding = config.entityPadding;
  const measure = (text: string) => measureMermaidGfxText(text, type),
    rowHeight = type.lineHeight + padding,
    headerHeight = type.lineHeight * 2 + padding * 2;
  const name =
      Math.max(
        measureMermaidGfxText(m.erName(), { ...type, fontWeight: "bold" })
          .width,
        ...entity.attributes.map((a) => measure(a.name).width),
      ) +
      padding * 2,
    typeWidth =
      Math.max(
        measureMermaidGfxText(m.erType(), { ...type, fontWeight: "bold" })
          .width,
        ...entity.attributes.map(
          (a) => measure(`${a.type}${a.optional ? "?" : ""}`).width,
        ),
      ) +
      padding * 2,
    keys =
      Math.max(
        measureMermaidGfxText(m.erKeys(), { ...type, fontWeight: "bold" })
          .width,
        ...entity.attributes.map(
          (a) =>
            a.keys.reduce(
              (sum, key) =>
                sum +
                measureMermaidGfxText(key, { ...type, fontWeight: "bold" })
                  .width +
                fontSize,
              0,
            ) +
            (Math.max(0, a.keys.length - 1) * fontSize) / 2,
        ),
      ) +
      padding * 2;
  return {
    fontSize,
    padding,
    rowHeight,
    headerHeight,
    columns: [name, typeWidth, keys] as const,
    width: Math.max(
      config.minEntityWidth,
      name + typeWidth + keys,
      measureMermaidGfxText(entity.label, {
        ...type,
        fontWeight: styles["font-weight"] ?? "bold",
      }).width +
        padding * 2,
      measure(entity.id).width + padding * 2,
    ),
    height: Math.max(
      config.minEntityHeight,
      headerHeight + rowHeight * (entity.attributes.length + 1) + padding,
    ),
  };
}
/** Cold placement uses the neutral graph ranks; owner reconciliation retains all
 * unaffected manual geometry. Label space belongs between cards, not inside them. */
export function layoutErNodes(
  nodes: MermaidVisualNode[],
  direction: string,
  edges: readonly { source: string; target: string; label: string }[],
  rankSpacing: number,
  nodeSpacing: number,
) {
  const horizontal = direction === "LR" || direction === "RL",
    reverse = direction === "RL" || direction === "BT",
    layers = mermaidGraphLayers(nodes, edges),
    maxLayer = Math.max(0, ...layers.values()),
    rows = new Map<number, MermaidVisualNode[]>();
  for (const node of nodes) {
    const rank = layers.get(node.id) ?? 0,
      physical = reverse ? maxLayer - rank : rank;
    rows.set(physical, [...(rows.get(physical) ?? []), node]);
  }
  const typography = resolveMermaidGfxProjectionTheme().typography,
    gap = Math.max(
      rankSpacing,
      ...edges.map((e) => {
        const label = measureMermaidGfxText(e.label, typography);
        return (
          (horizontal ? label.width : label.height) + typography.lineHeight * 4
        );
      }),
    );
  const positions = new Map<string, { x: number; y: number }>();
  let primary = 48;
  for (const [, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    let cross = 48;
    for (const node of row) {
      positions.set(node.id, {
        x: horizontal ? primary : cross,
        y: horizontal ? cross : primary,
      });
      cross += (horizontal ? node.height : node.width) + nodeSpacing;
    }
    primary +=
      Math.max(...row.map((n) => (horizontal ? n.width : n.height))) + gap;
  }
  return nodes.map((n) => ({ ...n, ...positions.get(n.id) }));
}

/** A group's measured box participates in its parent's neutral graph ranks.
 * This composes local directions without placing children over unrelated cards. */
export function layoutErHierarchy(
  model: MermaidErModel,
  nodes: MermaidVisualNode[],
  edges: MermaidVisualEdge[],
  config: ErConfig,
  styles: (id: string) => Readonly<Record<string, string>>,
) {
  type Frame = { x: number; y: number; width: number; height: number };
  const frames = new Map<string, Frame>();
  const parent = new Map(model.subgraphs.map((g) => [g.id, g.parentId]));
  const ids = new Map(
    [...model.entities, ...model.subgraphs].map((n) => [n.id, n.sourceKey]),
  );
  const sourceIds = new Map(
    [...model.entities, ...model.subgraphs].map((n) => [n.sourceKey, n.id]),
  );
  const memberships = new Map(model.entities.map((e) => [e.id, e.subgraphId]));
  const project = (
    scope: string | null,
  ): { nodes: MermaidVisualNode[]; width: number; height: number } => {
    const groups = model.subgraphs.filter((g) => g.parentId === scope),
      children = new Map(groups.map((g) => [g.id, project(g.id)]));
    const direct = nodes.filter(
      (n) => memberships.get(sourceIds.get(n.id)!) === scope,
    );
    const boxes: MermaidVisualNode[] = [
      ...direct,
      ...groups.map((g) => ({
        id: g.sourceKey,
        label: g.label,
        shape: "rect" as const,
        x: 0,
        y: 0,
        width: children.get(g.id)!.width,
        height: children.get(g.id)!.height,
      })),
    ];
    const rootFor = (key: string) => {
      const id = sourceIds.get(key);
      if (!id) return undefined;
      if (
        direct.some((n) => n.id === key) ||
        groups.some((g) => g.sourceKey === key)
      )
        return key;
      let group = memberships.get(id) ?? parent.get(id),
        visited = new Set<string>();
      while (group && !visited.has(group)) {
        visited.add(group);
        if (parent.get(group) === scope) return ids.get(group);
        group = parent.get(group);
      }
      return undefined;
    };
    const scopedEdges = edges.flatMap((e) => {
      const source = rootFor(e.source),
        target = rootFor(e.target);
      return source && target && source !== target
        ? [{ source, target, label: e.label }]
        : [];
    });
    const direction =
      model.subgraphs.find((g) => g.id === scope)?.direction ?? model.direction;
    const laid = layoutErNodes(
      boxes,
      direction,
      scopedEdges,
      config.rankSpacing,
      config.nodeSpacing,
    );
    const group = model.subgraphs.find((g) => g.id === scope),
      header = group
        ? erSubgraphHeaderMetrics(
            group.direction
              ? `${group.label} · ${group.direction}`
              : group.label,
            styles(group.id),
          )
        : null,
      paddingX = scope ? 24 : config.diagramPadding,
      paddingY = header?.height ?? config.diagramPadding;
    const result: MermaidVisualNode[] = [];
    for (const box of laid) {
      const x = box.x - 48 + paddingX,
        y = box.y - 48 + paddingY;
      const group = groups.find((g) => g.sourceKey === box.id);
      if (!group) {
        result.push({ ...box, x, y });
        continue;
      }
      const inner = children.get(group.id)!;
      result.push(
        ...inner.nodes.map((n) => ({ ...n, x: n.x + x, y: n.y + y })),
      );
      // Descendant frames already have local geometry; shift them with this box.
      const descendants = new Set(inner.nodes.map((n) => n.id));
      for (const [key, frame] of frames) {
        let source = sourceIds.get(key),
          p = source && parent.get(source);
        while (p && p !== group.id) p = parent.get(p);
        if (p === group.id || descendants.has(key))
          frames.set(key, { ...frame, x: frame.x + x, y: frame.y + y });
      }
      frames.set(group.sourceKey, {
        x,
        y,
        width: box.width,
        height: box.height,
      });
    }
    return {
      nodes: result,
      width: Math.max(
        header?.width ?? 0,
        laid.length
          ? Math.max(...laid.map((n) => n.x - 48 + n.width)) + paddingX * 2
          : scope
            ? 240
            : config.minEntityWidth,
      ),
      height: laid.length
        ? Math.max(...laid.map((n) => n.y - 48 + n.height)) +
          paddingY +
          (scope ? 24 : config.diagramPadding)
        : scope
          ? 140
          : config.minEntityHeight,
    };
  };
  return { nodes: project(null).nodes, frames };
}
