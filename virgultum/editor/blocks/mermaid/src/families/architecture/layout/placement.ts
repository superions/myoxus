// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureModel } from "../../../engine/architecture/index.js";
import type { MermaidVisualNode } from "../../runtime/gfx-model.js";
import {
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
  architectureSubgraphGfxData,
} from "../gfx-data.js";
import type {
  ArchitectureLayoutGroup,
  ArchitectureLayoutMeasurement,
} from "./measurement.js";
import { applyArchitectureEdgeDirections } from "./routing.js";

function architectureSeededRank(id: string, seed: number) {
  let hash = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  return hash >>> 0;
}

export function placeArchitectureLayout(
  model: MermaidArchitectureModel,
  measurement: ArchitectureLayoutMeasurement,
) {
  const {
    config,
    groups,
    metrics,
    nodes,
    relationMeasurements,
    typographyKey,
  } = measurement;
  const layoutOrder = <T extends { id: string }>(items: readonly T[]) =>
    config.randomize
      ? [...items].sort(
          (left, right) =>
            architectureSeededRank(left.id, config.seed) -
            architectureSeededRank(right.id, config.seed),
        )
      : [...items];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const directNodesByGroup = new Map<string, MermaidVisualNode[]>();
  for (const node of nodes) {
    const groupId = architectureNodeGfxData(node)?.groupId ?? "";
    const direct = directNodesByGroup.get(groupId) ?? [];
    direct.push(node);
    directNodesByGroup.set(groupId, direct);
  }
  const childGroupsByParent = new Map<string, ArchitectureLayoutGroup[]>();
  for (const group of groups) {
    const children = childGroupsByParent.get(group.parentId) ?? [];
    children.push(group);
    childGroupsByParent.set(group.parentId, children);
  }

  type GroupContent = ArchitectureLayoutGroup | MermaidVisualNode;
  type PackedGroup = {
    readonly columnWidths: readonly number[];
    readonly contents: readonly GroupContent[];
    readonly rowHeights: readonly number[];
  };
  const packedGroups = new Map<string, PackedGroup>();

  const packGroupContents = (
    contents: readonly GroupContent[],
  ): PackedGroup => {
    if (contents.length === 0) {
      return { columnWidths: [], contents, rowHeights: [] };
    }
    // Architecture does not prescribe a global direction. Choose the grid
    // whose measured width and height are closest to a balanced rectangle so
    // differently shaped content is neither forced into a single tall stack
    // nor an unbounded horizontal row. Explicit row/column alignments are
    // applied afterwards and remain the authoritative directional constraint.
    let best: PackedGroup | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (
      let columnCount = 1;
      columnCount <= contents.length;
      columnCount += 1
    ) {
      const columnWidths = Array.from({ length: columnCount }, () => 0);
      const rowHeights = Array.from(
        { length: Math.ceil(contents.length / columnCount) },
        () => 0,
      );
      for (const [index, item] of contents.entries()) {
        const column = index % columnCount;
        const row = Math.floor(index / columnCount);
        columnWidths[column] = Math.max(columnWidths[column] ?? 0, item.width);
        rowHeights[row] = Math.max(rowHeights[row] ?? 0, item.height);
      }
      const width = columnWidths.reduce(
        (sum, itemWidth, index) =>
          sum + itemWidth + (index === 0 ? 0 : metrics.inlineGap),
        0,
      );
      const height = rowHeights.reduce(
        (sum, itemHeight, index) =>
          sum + itemHeight + (index === 0 ? 0 : metrics.blockGap),
        0,
      );
      const score = Math.abs(Math.log(width / height));
      if (score < bestScore) {
        best = { columnWidths, contents, rowHeights };
        bestScore = score;
      }
    }
    if (!best) throw new Error("Architecture content packing failed.");
    return best;
  };
  const packedOffsets = (sizes: readonly number[], gap: number) => {
    const offsets: number[] = [];
    for (const index of sizes.keys()) {
      offsets.push(
        index === 0
          ? 0
          : (offsets[index - 1] ?? 0) + (sizes[index - 1] ?? 0) + gap,
      );
    }
    return offsets;
  };

  const measureGroup = (group: ArchitectureLayoutGroup) => {
    const children = childGroupsByParent.get(group.id) ?? [];
    for (const child of children) measureGroup(child);
    const packed = packGroupContents(
      layoutOrder([...(directNodesByGroup.get(group.id) ?? []), ...children]),
    );
    packedGroups.set(group.id, packed);
    const contentWidth = packed.columnWidths.reduce(
      (width, columnWidth, index) =>
        width + columnWidth + (index === 0 ? 0 : metrics.inlineGap),
      0,
    );
    const contentHeight = packed.rowHeights.reduce(
      (height, rowHeight, index) =>
        height + rowHeight + (index === 0 ? 0 : metrics.blockGap),
      0,
    );
    group.width = Math.max(
      group.width,
      contentWidth + metrics.groupInlineInset * 2,
    );
    group.height =
      group.headerHeight +
      metrics.groupBlockInset +
      contentHeight +
      (packed.contents.length ? metrics.groupBlockInset : 0);
  };
  const roots = childGroupsByParent.get("") ?? [];
  for (const root of roots) measureGroup(root);

  const positionGroup = (
    group: ArchitectureLayoutGroup,
    x: number,
    y: number,
  ) => {
    group.x = x;
    group.y = y;
    const packed = packedGroups.get(group.id);
    if (!packed) return;
    const columnOffsets = packedOffsets(packed.columnWidths, metrics.inlineGap);
    const rowOffsets = packedOffsets(packed.rowHeights, metrics.blockGap);
    const columnCount = packed.columnWidths.length;
    for (const [index, item] of packed.contents.entries()) {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      const itemX =
        x +
        metrics.groupInlineInset +
        (columnOffsets[column] ?? 0) +
        ((packed.columnWidths[column] ?? item.width) - item.width) / 2;
      const itemY =
        y +
        group.headerHeight +
        metrics.groupBlockInset +
        (rowOffsets[row] ?? 0) +
        ((packed.rowHeights[row] ?? item.height) - item.height) / 2;
      if ("parentId" in item) {
        positionGroup(item, itemX, itemY);
      } else {
        item.x = itemX;
        item.y = itemY;
      }
    }
  };
  const standalone = directNodesByGroup.get("") ?? [];
  const packedRoots = packGroupContents(layoutOrder([...roots, ...standalone]));
  const rootColumnOffsets = packedOffsets(
    packedRoots.columnWidths,
    metrics.inlineGap,
  );
  const rootRowOffsets = packedOffsets(
    packedRoots.rowHeights,
    metrics.blockGap,
  );
  const rootColumnCount = packedRoots.columnWidths.length;
  for (const [index, item] of packedRoots.contents.entries()) {
    const column = index % rootColumnCount;
    const row = Math.floor(index / rootColumnCount);
    const itemX =
      (rootColumnOffsets[column] ?? 0) +
      ((packedRoots.columnWidths[column] ?? item.width) - item.width) / 2;
    const itemY =
      (rootRowOffsets[row] ?? 0) +
      ((packedRoots.rowHeights[row] ?? item.height) - item.height) / 2;
    if ("parentId" in item) {
      positionGroup(item, itemX, itemY);
    } else {
      item.x = itemX;
      item.y = itemY;
    }
  }

  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const directGroupForNode = (node: MermaidVisualNode) =>
    groupsById.get(architectureNodeGfxData(node)?.groupId ?? "") ?? null;
  const groupContainsGroup = (
    ancestor: ArchitectureLayoutGroup,
    descendant: ArchitectureLayoutGroup,
  ) => {
    const visited = new Set<string>();
    let group: ArchitectureLayoutGroup | undefined = descendant;
    while (group && !visited.has(group.id)) {
      if (group.id === ancestor.id) return true;
      visited.add(group.id);
      group = groupsById.get(group.parentId);
    }
    return false;
  };
  const rootGroupForNode = (node: MermaidVisualNode) => {
    let groupId = architectureNodeGfxData(node)?.groupId ?? "";
    let root: ArchitectureLayoutGroup | null = null;
    const visited = new Set<string>();
    while (groupId && !visited.has(groupId)) {
      visited.add(groupId);
      const group = groupsById.get(groupId);
      if (!group) break;
      root = group;
      groupId = group.parentId;
    }
    return root;
  };
  const translateGroup = (
    group: ArchitectureLayoutGroup,
    deltaX: number,
    deltaY: number,
  ) => {
    group.x += deltaX;
    group.y += deltaY;
    for (const node of directNodesByGroup.get(group.id) ?? []) {
      node.x += deltaX;
      node.y += deltaY;
    }
    for (const child of childGroupsByParent.get(group.id) ?? []) {
      translateGroup(child, deltaX, deltaY);
    }
  };
  const moveTarget = (
    source: MermaidVisualNode,
    target: MermaidVisualNode,
    deltaX: number,
    deltaY: number,
  ) => {
    const sourceGroup = directGroupForNode(source);
    const targetGroup = directGroupForNode(target);
    if (
      !targetGroup ||
      (sourceGroup &&
        (sourceGroup === targetGroup ||
          groupContainsGroup(targetGroup, sourceGroup)))
    ) {
      target.x += deltaX;
      target.y += deltaY;
      return;
    }
    translateGroup(targetGroup, deltaX, deltaY);
  };

  const idealDistance = Math.max(
    config.nodeSeparation,
    config.idealEdgeLengthMultiplier * config.iconSize,
  );
  const relaxationPasses = Math.max(
    1,
    Math.min(24, Math.ceil(config.numIter / 250)),
  );
  for (let pass = 0; pass < relaxationPasses; pass += 1) {
    applyArchitectureEdgeDirections(
      model,
      nodesById,
      moveTarget,
      idealDistance,
      config.edgeElasticity,
      relationMeasurements,
    );
  }

  const fitGroupToContents = (group: ArchitectureLayoutGroup) => {
    const children = childGroupsByParent.get(group.id) ?? [];
    for (const child of children) fitGroupToContents(child);
    const owned = [...(directNodesByGroup.get(group.id) ?? []), ...children];
    if (owned.length === 0) return;
    const left = Math.min(
      ...owned.map((item) => item.x - metrics.groupInlineInset),
    );
    const top = Math.min(
      ...owned.map(
        (item) => item.y - group.headerHeight - metrics.groupBlockInset,
      ),
    );
    const titleWidth = group.headerWidth + metrics.groupInlineInset * 2;
    const right = Math.max(
      left + titleWidth,
      ...owned.map((item) => item.x + item.width + metrics.groupInlineInset),
    );
    const bottom = Math.max(
      top + group.headerHeight + metrics.groupBlockInset * 2,
      ...owned.map((item) => item.y + item.height + metrics.groupBlockInset),
    );
    group.x = left;
    group.y = top;
    group.width = right - left;
    group.height = bottom - top;
  };
  for (const root of roots) fitGroupToContents(root);

  for (const alignment of [...model.alignments].sort(
    (left, right) => left.order - right.order,
  )) {
    const members = alignment.members
      .map((id) => nodesById.get(id))
      .filter((node): node is MermaidVisualNode => Boolean(node));
    const first = members[0];
    if (!first) continue;
    const memberGroupIds = members.map(
      (member) => architectureNodeGfxData(member)?.groupId ?? "",
    );
    const memberCountInGroupSubtree = (group: ArchitectureLayoutGroup) =>
      memberGroupIds.filter((groupId) => {
        const memberGroup = groupsById.get(groupId);
        return memberGroup ? groupContainsGroup(group, memberGroup) : false;
      }).length;
    const carrierGroupForNode = (node: MermaidVisualNode) => {
      const group = directGroupForNode(node);
      return group && memberCountInGroupSubtree(group) === 1 ? group : null;
    };
    const anchorCenterX = first.x + first.width / 2;
    const anchorCenterY = first.y + first.height / 2;
    const carrierId = (node: MermaidVisualNode) => {
      const group = carrierGroupForNode(node);
      return group ? `group:${group.id}` : `node:${node.id}`;
    };
    const carrierBounds = (node: MermaidVisualNode) => {
      const group = carrierGroupForNode(node);
      const carrier = group ?? node;
      return {
        bottom: carrier.y + carrier.height,
        left: carrier.x,
        right: carrier.x + carrier.width,
        top: carrier.y,
      };
    };
    const positionedCarriers = new Set([carrierId(first)]);
    let previous = first;
    for (const member of members.slice(1)) {
      const previousGroup = carrierGroupForNode(previous);
      const memberGroup = carrierGroupForNode(member);
      const previousCarrier = carrierBounds(previous);
      const memberCarrier = carrierBounds(member);
      const memberCarrierId = carrierId(member);
      const moveCarrier = !positionedCarriers.has(memberCarrierId);
      const moveAlignedMember =
        !moveCarrier || (previousGroup && previousGroup === memberGroup)
          ? (deltaX: number, deltaY: number) => {
              member.x += deltaX;
              member.y += deltaY;
            }
          : (deltaX: number, deltaY: number) => {
              if (memberGroup) translateGroup(memberGroup, deltaX, deltaY);
              else {
                member.x += deltaX;
                member.y += deltaY;
              }
            };
      if (alignment.direction === "row") {
        const desiredX = previous.x + previous.width + metrics.inlineGap;
        const carrierGapX = moveCarrier
          ? previousCarrier.right + metrics.inlineGap - memberCarrier.left
          : Number.NEGATIVE_INFINITY;
        moveAlignedMember(
          Math.max(desiredX - member.x, carrierGapX),
          anchorCenterY - member.height / 2 - member.y,
        );
      } else {
        const desiredY = previous.y + previous.height + metrics.blockGap;
        const carrierGapY = moveCarrier
          ? previousCarrier.bottom + metrics.blockGap - memberCarrier.top
          : Number.NEGATIVE_INFINITY;
        moveAlignedMember(
          anchorCenterX - member.width / 2 - member.x,
          Math.max(desiredY - member.y, carrierGapY),
        );
      }
      positionedCarriers.add(memberCarrierId);
      previous = member;
    }
    for (const root of roots) fitGroupToContents(root);
  }

  for (const root of roots) fitGroupToContents(root);

  const carriers = [
    ...roots.map((group, order) => ({
      height: group.height,
      id: `group:${group.id}`,
      move: (deltaX: number, deltaY: number) =>
        translateGroup(group, deltaX, deltaY),
      order,
      width: group.width,
      x: group.x,
      y: group.y,
    })),
    ...standalone.map((node, order) => ({
      height: node.height,
      id: `node:${node.id}`,
      move: (deltaX: number, deltaY: number) => {
        node.x += deltaX;
        node.y += deltaY;
      },
      order: roots.length + order,
      width: node.width,
      x: node.x,
      y: node.y,
    })),
  ];
  const carrierIdByNodeId = new Map(
    nodes.map((node) => [
      node.id,
      rootGroupForNode(node)
        ? `group:${rootGroupForNode(node)!.id}`
        : `node:${node.id}`,
    ]),
  );
  const parentByCarrierId = new Map(
    carriers.map((carrier) => [carrier.id, carrier.id]),
  );
  const findCarrier = (id: string): string => {
    const parent = parentByCarrierId.get(id) ?? id;
    if (parent === id) return id;
    const root = findCarrier(parent);
    parentByCarrierId.set(id, root);
    return root;
  };
  const unionCarriers = (left: string, right: string) => {
    const leftRoot = findCarrier(left);
    const rightRoot = findCarrier(right);
    if (leftRoot !== rightRoot) parentByCarrierId.set(rightRoot, leftRoot);
  };
  for (const alignment of model.alignments) {
    const memberCarriers = alignment.members
      .map((member) => carrierIdByNodeId.get(member))
      .filter((id): id is string => Boolean(id));
    const firstCarrier = memberCarriers[0];
    if (!firstCarrier) continue;
    for (const carrier of memberCarriers.slice(1)) {
      unionCarriers(firstCarrier, carrier);
    }
  }
  const clusters = new Map<string, typeof carriers>();
  for (const carrier of carriers) {
    const cluster = clusters.get(findCarrier(carrier.id)) ?? [];
    cluster.push(carrier);
    clusters.set(findCarrier(carrier.id), cluster);
  }
  const packedClusters = [...clusters.values()]
    .map((cluster) => ({
      carriers: cluster,
      left: Math.min(...cluster.map((carrier) => carrier.x)),
      order: Math.min(...cluster.map((carrier) => carrier.order)),
      right: Math.max(...cluster.map((carrier) => carrier.x + carrier.width)),
      bottom: Math.max(...cluster.map((carrier) => carrier.y + carrier.height)),
      top: Math.min(...cluster.map((carrier) => carrier.y)),
    }))
    .sort(
      (left, right) =>
        left.top - right.top ||
        left.left - right.left ||
        left.order - right.order,
    );
  const positionedClusters: typeof packedClusters = [];
  for (const cluster of packedClusters) {
    const occupiedRight = Math.max(
      Number.NEGATIVE_INFINITY,
      ...positionedClusters
        .filter(
          (positioned) =>
            positioned.top < cluster.bottom && positioned.bottom > cluster.top,
        )
        .map((positioned) => positioned.right),
    );
    const minimumX = Number.isFinite(occupiedRight)
      ? occupiedRight + metrics.inlineGap
      : cluster.left;
    if (cluster.left < minimumX) {
      const deltaX = minimumX - cluster.left;
      for (const carrier of cluster.carriers) {
        carrier.move(deltaX, 0);
        carrier.x += deltaX;
      }
      cluster.left += deltaX;
      cluster.right += deltaX;
    }
    positionedClusters.push(cluster);
  }

  // Alignment can move every root carrier away from the initial layout
  // origin. The projection owner intentionally preserves positive family
  // coordinates because they may be user-authored, so generated layout must
  // normalize its own origin before it crosses that boundary. Otherwise the
  // abandoned leading interval becomes visible whitespace and Auto fit makes
  // the actual Architecture content unnecessarily small.
  const layoutItems = [...roots, ...standalone];
  const layoutLeft = Math.min(...layoutItems.map((item) => item.x));
  const layoutTop = Math.min(...layoutItems.map((item) => item.y));
  if (layoutItems.length > 0 && (layoutLeft !== 0 || layoutTop !== 0)) {
    for (const root of roots) {
      translateGroup(root, -layoutLeft, -layoutTop);
    }
    for (const node of standalone) {
      node.x -= layoutLeft;
      node.y -= layoutTop;
    }
  }

  return {
    nodes,
    subgraphs: groups.map(
      ({
        headerHeight: _headerHeight,
        headerWidth: _headerWidth,
        parentId,
        ...group
      }) => ({
        ...group,
        parentId: parentId || undefined,
        familyData: architectureSubgraphFamilyData({
          ...architectureSubgraphGfxData(group)!,
          intrinsicHeight: group.height,
          intrinsicWidth: group.width,
          typographyKey,
        }),
      }),
    ),
  };
}
