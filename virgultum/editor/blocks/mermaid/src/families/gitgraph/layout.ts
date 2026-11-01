// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../../engine/gitgraph/index.js";

import {
  gitGraphDocument,
  readGitGraphConfig,
  orderedGitGraphBranches,
} from "../../engine/gitgraph/index.js";
import {
  measureMermaidGfxText,
  resolveMermaidGfxProjectionTheme,
} from "../../mermaid-gfx-theme.js";
/** Renderer geometry is measured in the same projected font/style that paints
 * each carrier. Both orientations reserve label extents before placing lanes. */
export function layoutGitGraphCarriers(model: MermaidGitGraphModel) {
  const config = readGitGraphConfig(gitGraphDocument(model)).config,
    theme = resolveMermaidGfxProjectionTheme(),
    font = theme.typography,
    bold = { ...font, fontWeight: "bold" },
    line = font.lineHeight;
  const wrap = (text: string, max: number, style = font) => {
    const lines: string[] = [];
    for (const paragraph of text.split(/\r\n|\r|\n/)) {
      let value = "";
      for (const token of paragraph.split(/(\s+)/)) {
        if (!token) continue;
        if (value && measureMermaidGfxText(value + token, style).width > max) {
          lines.push(value.trimEnd());
          value = "";
        }
        if (!value && /^\s+$/.test(token)) continue;
        for (const char of token) {
          if (value && measureMermaidGfxText(value + char, style).width > max) {
            lines.push(value);
            value = "";
          }
          value += char;
        }
      }
      lines.push(value.trimEnd());
    }
    return lines.join("\n");
  };
  const ordered = orderedGitGraphBranches(model),
    laneIndex = new Map(ordered.map((b, i) => [b.id, i])),
    effective = [...(model.derivedGraph?.effectiveMap.values() ?? [])].sort(
      (a, b) => a.order - b.order,
    );
  const tagPadding = [line / 8, line / 3] as const;
  const measureTag = (value: string) => {
    const size = measureMermaidGfxText(wrap(value, 160), font);
    return {
      width: Math.max(line, size.width) + tagPadding[1] * 2,
      height: size.height + tagPadding[0] * 2,
    };
  };
  const layoutTags = (values: readonly string[]) => {
    const positions: Array<{ x: number; y: number }> = [];
    let x = 0,
      y = 0,
      rowHeight = 0,
      width = 0;
    for (const value of values) {
      const size = measureTag(value);
      if (x && x + size.width > 160 + tagPadding[1] * 2) {
        y += rowHeight + tagPadding[1];
        x = 0;
        rowHeight = 0;
      }
      positions.push({ x, y });
      width = Math.max(width, x + size.width);
      x += size.width + tagPadding[1];
      rowHeight = Math.max(rowHeight, size.height);
    }
    return { positions, width, height: y + rowHeight };
  };
  const carrierSizes = new Map(
    effective.map((c) => {
      const id = measureMermaidGfxText(
          wrap(c.sourceId || c.kind, 160, bold),
          bold,
        ),
        message = measureMermaidGfxText(
          wrap(c.kind === "commit" ? c.message : "", 160),
          font,
        ),
        tags = layoutTags(c.tags),
        messageHeight = c.kind === "commit" && c.message ? message.height : 0,
        rotated = config.rotateCommitLabel
          ? (id.width + id.height) / Math.sqrt(2)
          : id.height;
      return [
        c.sourceKey,
        {
          width: Math.max(
            config.rotateCommitLabel ? rotated : id.width,
            message.width,
            tags.width,
          ),
          above: config.showCommitLabel ? rotated + line : line,
          below: line + messageHeight + tags.height,
          messageHeight,
          tags,
        },
      ];
    }),
  );
  const vertical = model.direction !== "LR";
  const advance = Math.max(
      line * 6,
      ...[...carrierSizes.values()].map((s) =>
        vertical ? s.above + s.below + line * 4 : s.width + line * 2,
      ),
    ),
    laneAdvance = Math.max(
      line * 5,
      ...[...carrierSizes.values()].map((s) =>
        vertical ? s.width + line * 4 : s.above + s.below + line * 2,
      ),
    ),
    gutter = Math.max(
      line * 4,
      ...ordered.map(
        (b) =>
          // Reserve the active dot on every lane so Checkout does not shift
          // the complete graph when the active branch changes.
          measureMermaidGfxText(wrap(`● ${b.name}`, 160, bold), bold).width +
          line * 2,
      ),
    ),
    padding = config.diagramPadding,
    firstY =
      padding +
      Math.max(line * 3, ...[...carrierSizes.values()].map((s) => s.above)) +
      line * 2,
    points = new Map<string, { x: number; y: number }>(),
    columns = new Map<string, number>();
  let column = 0;
  for (const c of effective) {
    const parents = c.parentReferences
        .map((id) => model.derivedGraph!.effectiveMap.get(id))
        .filter((p) => !!p),
      own = config.parallelCommits
        ? Math.max(
            0,
            ...parents.map((p) => (columns.get(p.sourceKey) ?? -1) + 1),
          )
        : column++;
    columns.set(c.sourceKey, own);
    points.set(c.sourceKey, {
      x: padding + gutter + line * 2 + own * advance,
      y: firstY + (laneIndex.get(c.branchId) ?? 0) * laneAdvance,
    });
  }
  return {
    config,
    font,
    bold,
    line,
    wrap,
    ordered,
    laneIndex,
    effective,
    advance,
    laneAdvance,
    gutter,
    points,
    firstY,
    padding,
    carrierSizes,
    measureTag,
  };
}
