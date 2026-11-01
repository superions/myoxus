// SPDX-License-Identifier: AGPL-3.0-or-later
import { blockStyles, blockTypography } from "./grid-projection.js";
import type { MermaidBlockDiagramModel } from "../../engine/block/index.js";
import {
  isBlockGroup,
  isBlockNode,
} from "../../engine/block/commands/block-commands.js";
import { blockGridSlots } from "../../engine/block/commands/grid-commands.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
export type BlockGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  row: number;
  span: number;
  slot: number;
};
export type BlockGridGeometry = {
  parent: string | null;
  columns: number;
  cellWidth: number;
  rows: readonly { y: number; height: number }[];
  x: number;
  y: number;
  width: number;
  height: number;
};
/** Source slots and measured protected bodies produce one finite projection.
 * Zero values keep their semantics; their technical edit bounds occupy no slot. */
export function layoutBlockModel(model: MermaidBlockDiagramModel) {
  const typography = resolveMermaidGfxProjectionTheme().typography,
    padding = model.config.padding <= 10000 ? model.config.padding : 8,
    gap = padding,
    header = typography.lineHeight + padding * 2;
  const objects = new Map<string, BlockGeometry>(),
    grids = new Map<string | null, BlockGridGeometry>(),
    size = new Map<string, { width: number; height: number }>();
  const items = [...model.nodes, ...model.groups, ...model.spaces];
  const measure = (
    parent: string | null,
  ): { width: number; height: number } => {
    const rawSlots = blockGridSlots(model, parent),
      // Unbounded Source values retain their records and diagnostics. Their
      // affected scope uses a finite edit lane instead of allocating huge rows.
      unsafe = rawSlots.some(
        (s) =>
          !Number.isSafeInteger(s.slot) ||
          s.slot > 10000 ||
          !Number.isSafeInteger(s.span) ||
          s.span > 10000,
      ),
      slots = unsafe
        ? rawSlots.map((s, index) => ({ ...s, column: 0, row: index, span: 1 }))
        : rawSlots,
      children = slots.map((s) => items.find((n) => n.sourceKey === s.key)!);
    for (const n of children) {
      if (isBlockGroup(n)) {
        const body = measure(n.bodyKey),
          label = measureMermaidGfxText(
            n.label || n.id,
            blockTypography(blockStyles(model, n)),
          );
        size.set(n.sourceKey, {
          width: Math.max(body.width + padding * 2, label.width + padding * 4),
          height: body.height + header + padding * 2,
        });
      } else if (isBlockNode(n)) {
        const type = blockTypography(blockStyles(model, n)),
          text = measureMermaidGfxText(
            n.label.replace(/<br\s*\/?\s*>/gi, "\n"),
            type,
          ),
          arrow = n.syntax === "block-arrow";
        size.set(n.sourceKey, {
          width: Math.max(
            typography.lineHeight * 3,
            arrow
              ? Math.max(
                  (text.width + padding * 2) * 3,
                  (text.height + padding * 2) * 3 + padding * 4,
                )
              : text.width + type.lineHeight * 2 + padding * 2,
          ),
          height: arrow
            ? (text.height + padding * 2) * 3
            : text.height + type.lineHeight + padding * 2,
        });
      }
    }
    const cellWidth = Math.max(
      typography.lineHeight * 3,
      ...children
        .filter(isBlockNode)
        .map(
          (n) =>
            (size.get(n.sourceKey)!.width -
              gap * Math.max(0, (unsafe ? 1 : n.span) - 1)) /
            Math.max(1, unsafe ? 1 : n.span),
        ),
    );
    const rows = new Map<number, number>();
    for (const s of slots) {
      const n = items.find((n) => n.sourceKey === s.key)!;
      rows.set(
        s.row,
        Math.max(
          rows.get(s.row) ?? typography.lineHeight,
          size.get(n.sourceKey)?.height ?? typography.lineHeight,
        ),
      );
    }
    const rowGeometry: Array<{ y: number; height: number }> = [];
    let y = 0;
    for (let row = 0; row <= Math.max(0, ...rows.keys()); row++) {
      const height = rows.get(row) ?? typography.lineHeight;
      rowGeometry.push({ y, height });
      y += height + gap;
    }
    const columns = parent
      ? (model.groups.find((g) => g.bodyKey === parent)?.columns ?? -1)
      : model.columns;
    for (const s of slots) {
      const n = items.find((n) => n.sourceKey === s.key)!,
        isSpace = !isBlockNode(n),
        width = isSpace
          ? Math.max(typography.lineHeight, s.span * (cellWidth + gap) - gap)
          : s.span === 0
            ? size.get(s.key)!.width
            : cellWidth * s.span + gap * Math.max(0, s.span - 1);
      objects.set(s.key, {
        x: s.column * (cellWidth + gap),
        y: rowGeometry[s.row]!.y,
        width,
        height: rowGeometry[s.row]!.height,
        ...s,
      });
    }
    const extent = Math.max(
        1,
        ...slots.map((s) => s.column + Math.max(0, s.span)),
      ),
      width = Math.max(
        typography.lineHeight * 3,
        extent * (cellWidth + gap) - gap,
      ),
      height = Math.max(typography.lineHeight * 2, y - gap);
    grids.set(parent, {
      parent,
      columns,
      cellWidth,
      rows: rowGeometry,
      x: 0,
      y: 0,
      width,
      height,
    });
    return { width, height };
  };
  measure(null);
  const place = (parent: string | null, x: number, y: number) => {
    const grid = grids.get(parent);
    if (grid) {
      grid.x = x;
      grid.y = y;
    }
    for (const n of items.filter((n) => n.parentKey === parent)) {
      const g = objects.get(n.sourceKey);
      if (!g) continue;
      g.x += x;
      g.y += y;
      if (isBlockGroup(n)) place(n.bodyKey, g.x + padding, g.y + header);
    }
  };
  place(null, 0, 0);
  // Native class-before-declaration has no child placement. A bounded diagnostic
  // lane keeps that source object reachable without inventing a grid slot.
  let unresolvedY = grids.get(null)!.height + gap;
  for (const n of [...model.nodes, ...model.groups].filter(
    (n) => !objects.has(n.sourceKey),
  )) {
    const text = measureMermaidGfxText(n.label || n.id, typography);
    objects.set(n.sourceKey, {
      x: 0,
      y: unresolvedY,
      width: text.width + typography.lineHeight * 2,
      height: text.height + typography.lineHeight,
      column: 0,
      row: 0,
      span: n.span,
      slot: -1,
    });
    unresolvedY += text.height + typography.lineHeight + gap;
  }
  return { objects, grids, typography, padding };
}

export function blockBodyGeometry(g: BlockGeometry) {
  return { x: g.x, y: g.y, width: g.width, height: g.height };
}
