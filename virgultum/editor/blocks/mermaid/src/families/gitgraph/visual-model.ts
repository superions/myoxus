// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  gitGraphDocument,
  gitGraphReferenceRuntimeValue,
  type MermaidGitGraphModel,
} from "../../engine/gitgraph/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { measureMermaidGfxText } from "../../mermaid-gfx-theme.js";
import {
  gitGraphBinding,
  gitGraphData,
  gitGraphModelData,
} from "./gfx-data.js";
import { gitGraphAccessibleContext } from "./accessibility.js";
import { gitGraphCommitMark } from "./commit-projection.js";
import { gitGraphBranchLabel } from "./branch-projection.js";
import { layoutGitGraphCarriers } from "./layout.js";
import { gitGraphRelationships } from "./relationship-projection.js";
import { gitGraphStatementMarker } from "./statement-projection.js";
import { gitGraphCommentMarker } from "./annotation-projection.js";
/** All carriers participate in measured bounds. Source determines both axes;
 * owner placement and global viewport remain outside this projection. */
export function gitGraphModelToVisual(
  model: MermaidGitGraphModel,
): MermaidVisualModel {
  const doc = gitGraphDocument(model),
    {
      config,
      font,
      bold,
      firstY,
      padding,
      carrierSizes,
      advance,
      line,
      wrap,
      ordered,
      laneIndex,
      effective,
      laneAdvance,
      gutter,
      points,
      measureTag,
    } = layoutGitGraphCarriers(model);
  const nodes: MermaidVisualNode[] = [];
  const text = (
    key: string,
    role: "id" | "message" | "tag",
    value: string,
    x: number,
    y: number,
    tagIndex?: number,
    attributeKey?: string,
  ) => {
    const style = role === "id" ? bold : font,
      label = wrap(value, 160, style),
      size =
        role === "tag"
          ? measureTag(value)
          : measureMermaidGfxText(label, style);
    nodes.push({
      id: attributeKey
        ? `${attributeKey}:tag`
        : `${key}:${role}${tagIndex === undefined ? "" : `:${tagIndex}`}`,
      label: value,
      displayLabel: label,
      labelEditable: false,
      shape: role === "tag" ? "rounded" : "text",
      x: x - size.width / 2,
      y,
      width: Math.max(line, size.width),
      height: size.height,
      rotate: role === "id" && config.rotateCommitLabel ? -45 : 0,
      familyData: gitGraphData({
        role,
        sourceKey: key,
        tagIndex: tagIndex ?? null,
        attributeKey: attributeKey ?? null,
        branch:
          model.derivedGraph?.occurrences.find((c) => c.sourceKey === key)
            ?.branchId ?? null,
      }),
    });
    return size.height;
  };
  for (const c of effective) {
    const p = points.get(c.sourceKey)!;
    nodes.push(gitGraphCommitMark(c, p.x, p.y));
    if (config.showCommitLabel)
      text(
        c.sourceKey,
        "id",
        c.sourceId || c.kind,
        p.x,
        p.y - (carrierSizes.get(c.sourceKey)?.above ?? line * 2),
      );
    let y = p.y + line;
    if (c.kind === "commit" && c.message)
      y += text(c.sourceKey, "message", c.message, p.x, y);
    const tags =
      doc.records
        .find((r) => r.sourceKey === c.sourceKey)
        ?.attributes.filter(
          (a) =>
            a.name === "tag" && (c.kind !== "cherry-pick" || a.value !== ""),
        ) ?? [];
    const tagLayout = carrierSizes.get(c.sourceKey)!.tags;
    for (const [i, tag] of c.tags.entries()) {
      const position = tagLayout.positions[i]!;
      const size = measureTag(tag);
      text(
        c.sourceKey,
        "tag",
        tag,
        p.x - tagLayout.width / 2 + position.x + size.width / 2,
        y + position.y,
        i,
        tags[i]?.sourceKey,
      );
    }
  }
  for (const branch of ordered) {
    const r =
      branch.id === model.mainBranchId
        ? doc.records.find((r) => r.kind === "header")
        : doc.records.find(
            (r) =>
              r.kind === "branch" &&
              gitGraphReferenceRuntimeValue(
                r,
                model.derivedGraph?.sanitization,
              ) === branch.id,
          );
    if (!r) continue;
    const y = firstY + (laneIndex.get(branch.id) ?? 0) * laneAdvance,
      active = model.derivedGraph?.finalContext.branch === branch.id,
      display = wrap(active ? `● ${branch.name}` : branch.name, 160, bold),
      size = measureMermaidGfxText(display, bold),
      height = size.height + line / 2;
    nodes.push(
      gitGraphBranchLabel(
        r.sourceKey,
        branch.name,
        padding,
        y - height / 2,
        gutter - line,
        height,
        branch.id,
      ),
    );
    const label = nodes.at(-1)!;
    label.displayLabel = display;
    label.familyData = gitGraphData({
      ...label.familyData!.payload,
      authoringGuide: !config.showBranches,
    });
    const originKey = model.derivedGraph?.contexts.find(
        (c) => c.sourceKey === r.sourceKey,
      )?.head,
      origin = originKey ? points.get(originKey) : null,
      originX = origin ? origin.x + advance / 2 : padding + gutter + line;
    nodes.push({
      id: `${r.sourceKey}:origin`,
      label: branch.name,
      displayLabel: "",
      labelEditable: false,
      shape: "circle",
      x: originX - 4,
      y: y - 4,
      width: 8,
      height: 8,
      familyData: gitGraphData({
        role: "branch",
        sourceKey: r.sourceKey,
        branch: branch.id,
        origin: originKey ?? null,
        authoringGuide: !config.showBranches,
      }),
    });
    const commits = effective.filter((c) => c.branchId === branch.id),
      headKey = model.derivedGraph?.finalContext.branchHeads.get(branch.id),
      head = headKey ? points.get(headKey) : null,
      start = commits.length
        ? Math.min(...commits.map((c) => points.get(c.sourceKey)!.x))
        : padding + gutter + line,
      end =
        Math.max(
          start + line * 2,
          ...effective.map((c) => points.get(c.sourceKey)!.x),
        ) +
        line * 2;
    nodes.push({
      id: `${r.sourceKey}:rail`,
      label: "",
      shape: "rect",
      x: padding + gutter,
      y: y - 0.5,
      width: end - padding - gutter,
      height: 1,
      familyData: gitGraphData({
        role: "rail",
        sourceKey: r.sourceKey,
        branch: branch.id,
        authoringGuide: !config.showBranches,
      }),
    });
    if (head)
      nodes.push({
        id: `${r.sourceKey}:head`,
        label: branch.name,
        displayLabel: "◀",
        shape: "text",
        x:
          (model.derivedGraph?.occurrences.find((c) => c.sourceKey === headKey)
            ?.branchId === branch.id
            ? head.x
            : originX) + line,
        y: y - line / 2,
        width: line,
        height: line,
        labelEditable: false,
        familyData: gitGraphData({
          role: "branch",
          sourceKey: r.sourceKey,
          branch: branch.id,
          authoringGuide: !config.showBranches,
          head: headKey,
        }),
      });
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const c of effective)
    positions.set(c.sourceKey, points.get(c.sourceKey)!);
  const markerSlots = new Map<string, number>();
  for (const r of doc.records) {
    if (
      r.kind === "checkout" ||
      model.derivedGraph?.occurrences.some(
        (c) => c.sourceKey === r.sourceKey && c.shadowed,
      )
    ) {
      const context = model.derivedGraph?.contexts.find(
          (c) => c.sourceKey === r.sourceKey,
        ),
        p = context?.head ? points.get(context.head) : null,
        slot = markerSlots.get(context?.head ?? "empty") ?? 0,
        point = {
          x: (p?.x ?? gutter) + slot * line * 1.5,
          // Authoring statements sit above measured ID captions, not on them.
          y:
            (p?.y ?? firstY) -
            (carrierSizes.get(context?.head ?? "")?.above ?? line * 2) -
            line * 1.5,
        };
      markerSlots.set(context?.head ?? "empty", slot + 1);
      nodes.push(gitGraphStatementMarker(r, point.x, point.y, line));
      positions.set(r.sourceKey, point);
    }
  }
  for (const [i, r] of doc.records
    .filter((r) => r.kind === "comment")
    .entries()) {
    const p = r.anchor && positions.get(r.anchor.sourceKey);
    nodes.push(
      gitGraphCommentMarker(
        r,
        (p?.x ?? gutter) + line,
        (p?.y ?? firstY) - line * (4 + i),
        line,
      ),
    );
  }
  // Transpose the graph axes, then retain readable caption stacks around each
  // transformed commit. Rotating caption offsets alone makes ID/message/tag
  // carriers collide because their text itself remains horizontal.
  if (model.direction !== "LR") {
    const max = Math.max(0, ...nodes.map((n) => n.x + n.width));
    for (const n of nodes) {
      const cx = n.x + n.width / 2,
        cy = n.y + n.height / 2;
      if (gitGraphBinding(n)?.role === "rail") {
        const w = n.width;
        n.width = n.height;
        n.height = w;
      }
      n.x = cy - n.width / 2;
      n.y = (model.direction === "BT" ? max - cx : cx) - n.height / 2;
      if (n.id.endsWith(":head"))
        n.rotate = model.direction === "BT" ? -90 : 90;
    }
    const marks = new Map(
      nodes
        .filter((n) => gitGraphBinding(n)?.role === "commit")
        .map((n) => [n.id, n]),
    );
    for (const c of effective) {
      const mark = marks.get(c.sourceKey)!;
      const x = mark.x + mark.width / 2,
        y = mark.y + mark.height / 2;
      const below = y + line;
      for (const n of nodes) {
        const binding = gitGraphBinding(n);
        if (binding?.sourceKey !== c.sourceKey) continue;
        if (binding.role === "id") {
          const rotatedWidth = n.rotate
            ? (n.width + n.height) / Math.sqrt(2)
            : n.width;
          n.x = x + line + Math.max(0, (rotatedWidth - n.width) / 2);
          n.y = y - (carrierSizes.get(c.sourceKey)?.above ?? line * 2);
        } else if (binding.role === "message") {
          n.x = x + line;
          n.y = below;
        } else if (binding.role === "tag") {
          const metrics = carrierSizes.get(c.sourceKey)!;
          const position = metrics.tags.positions[binding.tagIndex ?? 0]!;
          n.x = x + line + position.x;
          n.y = y + line + metrics.messageHeight + position.y;
        }
      }
    }
    for (const n of nodes) {
      const binding = gitGraphBinding(n);
      if (binding?.role === "statement") {
        const context = model.derivedGraph?.contexts.find(
          (c) => c.sourceKey === binding.sourceKey,
        );
        const mark = context?.head ? marks.get(context.head) : null;
        if (!mark) continue;
        const previous = positions.get(binding.sourceKey)!;
        const original = points.get(context!.head!)!;
        n.x = mark.x + mark.width / 2 + previous.x - original.x;
        n.y =
          mark.y +
          mark.height / 2 -
          (carrierSizes.get(context!.head!)?.above ?? line * 2) -
          line * 1.5;
      } else if (binding?.role === "comment") {
        const record = doc.records.find(
          (r) => r.sourceKey === binding.sourceKey,
        );
        const anchor = record?.anchor
          ? nodes.find((candidate) => candidate.id === record.anchor!.sourceKey)
          : null;
        if (!anchor) continue;
        n.x = anchor.x - line * 2;
        n.y = anchor.y - line;
      }
    }
  }
  return {
    diagramType: "gitGraph",
    direction: model.direction,
    nodes: nodes.map((n) => ({
      ...n,
      familyData: gitGraphAccessibleContext(model, n),
    })),
    edges: gitGraphRelationships(model).map((e) => ({
      ...e,
      familyData: gitGraphAccessibleContext(model, e),
    })),
    subgraphs: [],
    styleStatements: [],
    familyData: gitGraphModelData(model),
    version: 1,
  };
}
