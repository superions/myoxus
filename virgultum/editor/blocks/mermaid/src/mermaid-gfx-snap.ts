// SPDX-License-Identifier: AGPL-3.0-or-later

/** Matches the base 20px Edgeless dot-grid step (`get-bg-grip-gap.ts`). */
export const MERMAID_GFX_GRID_SIZE = 20;

/** Screen-space magnetic snap threshold for dynamic alignment guides. */
export const MERMAID_GFX_SNAP_TOLERANCE_PX = 6;

const GUIDE_OVERHANG_PX = 8;

export type MermaidGfxSnapRect = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type MermaidGfxSnapGuide = {
  readonly axis: "x" | "y";
  readonly position: number;
  readonly start: number;
  readonly end: number;
  readonly kind: "align" | "spacing";
  readonly spacingGap?: number;
};

export type MermaidGfxMoveSnapResult = {
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly MermaidGfxSnapGuide[];
};

export type MermaidGfxResizeSnapResult = {
  readonly width: number;
  readonly height: number;
  readonly guides: readonly MermaidGfxSnapGuide[];
};

export function snapValueToMermaidGrid(
  value: number,
  gridSize = MERMAID_GFX_GRID_SIZE,
) {
  if (!Number.isFinite(value) || !Number.isFinite(gridSize) || gridSize <= 0) {
    return value;
  }
  return Math.round(value / gridSize) * gridSize;
}

type AxisAlignmentMatch = {
  readonly delta: number;
  readonly guides: MermaidGfxSnapGuide[];
};

function findAxisAlignment(
  moving: {
    readonly start: number;
    readonly size: number;
    readonly crossStart: number;
    readonly crossEnd: number;
  },
  candidates: readonly {
    readonly start: number;
    readonly size: number;
    readonly crossStart: number;
    readonly crossEnd: number;
  }[],
  axis: "x" | "y",
  tolerance: number,
): AxisAlignmentMatch | null {
  const movingPoints = [
    moving.start,
    moving.start + moving.size / 2,
    moving.start + moving.size,
  ];
  let bestAbsDelta = tolerance + 0.0001;
  let bestDelta = 0;
  let matchedPositions: {
    position: number;
    crossStart: number;
    crossEnd: number;
  }[] = [];

  for (const candidate of candidates) {
    const candidatePoints = [
      candidate.start,
      candidate.start + candidate.size / 2,
      candidate.start + candidate.size,
    ];
    for (const mPt of movingPoints) {
      for (const cPt of candidatePoints) {
        const delta = cPt - mPt;
        const absDelta = Math.abs(delta);
        if (absDelta > tolerance) continue;
        if (absDelta < bestAbsDelta - 0.01) {
          bestAbsDelta = absDelta;
          bestDelta = delta;
          matchedPositions = [
            {
              position: cPt,
              crossStart: Math.min(moving.crossStart, candidate.crossStart),
              crossEnd: Math.max(moving.crossEnd, candidate.crossEnd),
            },
          ];
        } else if (Math.abs(delta - bestDelta) <= 0.01) {
          matchedPositions.push({
            position: cPt,
            crossStart: Math.min(moving.crossStart, candidate.crossStart),
            crossEnd: Math.max(moving.crossEnd, candidate.crossEnd),
          });
        }
      }
    }
  }

  if (matchedPositions.length === 0) return null;

  // Merge collinear guides at the same axis position into one continuous span.
  const merged = new Map<
    number,
    { position: number; crossStart: number; crossEnd: number }
  >();
  for (const match of matchedPositions) {
    const key = Math.round(match.position * 10);
    const existing = merged.get(key);
    if (existing) {
      existing.crossStart = Math.min(existing.crossStart, match.crossStart);
      existing.crossEnd = Math.max(existing.crossEnd, match.crossEnd);
    } else {
      merged.set(key, { ...match });
    }
  }

  return {
    delta: bestDelta,
    guides: [...merged.values()].map((entry) => ({
      axis,
      position: entry.position,
      start: entry.crossStart - GUIDE_OVERHANG_PX,
      end: entry.crossEnd + GUIDE_OVERHANG_PX,
      kind: "align",
    })),
  };
}

function findEqualSpacingMatch(
  moving: {
    readonly start: number;
    readonly size: number;
    readonly crossStart: number;
    readonly crossEnd: number;
  },
  candidates: readonly {
    readonly start: number;
    readonly size: number;
    readonly crossStart: number;
    readonly crossEnd: number;
  }[],
  axis: "x" | "y",
  tolerance: number,
): AxisAlignmentMatch | null {
  // Only consider siblings that overlap along the perpendicular band.
  const bandSiblings = candidates
    .filter(
      (candidate) =>
        candidate.crossEnd > moving.crossStart &&
        candidate.crossStart < moving.crossEnd,
    )
    .sort((a, b) => a.start - b.start);

  if (bandSiblings.length < 2) return null;

  const movingEnd = moving.start + moving.size;
  let bestDelta: number | null = null;
  let bestAbs = tolerance + 0.0001;
  let bestGuides: MermaidGfxSnapGuide[] = [];

  // Case 1: moving is between two adjacent siblings A and B (equal left/right gap).
  for (let i = 0; i < bandSiblings.length - 1; i++) {
    const prev = bandSiblings[i]!;
    const next = bandSiblings[i + 1]!;
    const prevEnd = prev.start + prev.size;
    if (moving.start < prevEnd || movingEnd > next.start) continue;
    const freeSpace = next.start - prevEnd - moving.size;
    if (freeSpace <= 2) continue;
    const targetStart = prevEnd + freeSpace / 2;
    const delta = targetStart - moving.start;
    const abs = Math.abs(delta);
    if (abs < bestAbs) {
      bestAbs = abs;
      bestDelta = delta;
      const midCross = (moving.crossStart + moving.crossEnd) / 2;
      const gap = Math.round(freeSpace / 2);
      bestGuides = [
        {
          axis: axis === "x" ? "y" : "x",
          position: midCross,
          start: prevEnd,
          end: targetStart,
          kind: "spacing",
          spacingGap: gap,
        },
        {
          axis: axis === "x" ? "y" : "x",
          position: midCross,
          start: targetStart + moving.size,
          end: next.start,
          kind: "spacing",
          spacingGap: gap,
        },
      ];
    }
  }

  // Case 2: moving continues the gap established by two preceding or following siblings.
  for (let i = 0; i < bandSiblings.length - 1; i++) {
    const a = bandSiblings[i]!;
    const b = bandSiblings[i + 1]!;
    const gap = b.start - (a.start + a.size);
    if (gap <= 2) continue;

    // After B:
    const afterStart = b.start + b.size + gap;
    const afterDelta = afterStart - moving.start;
    if (Math.abs(afterDelta) < bestAbs) {
      bestAbs = Math.abs(afterDelta);
      bestDelta = afterDelta;
      const midCross = (moving.crossStart + moving.crossEnd) / 2;
      bestGuides = [
        {
          axis: axis === "x" ? "y" : "x",
          position: midCross,
          start: a.start + a.size,
          end: b.start,
          kind: "spacing",
          spacingGap: Math.round(gap),
        },
        {
          axis: axis === "x" ? "y" : "x",
          position: midCross,
          start: b.start + b.size,
          end: afterStart,
          kind: "spacing",
          spacingGap: Math.round(gap),
        },
      ];
    }

    // Before A:
    const beforeStart = a.start - gap - moving.size;
    const beforeDelta = beforeStart - moving.start;
    if (Math.abs(beforeDelta) < bestAbs) {
      bestAbs = Math.abs(beforeDelta);
      bestDelta = beforeDelta;
      const midCross = (moving.crossStart + moving.crossEnd) / 2;
      bestGuides = [
        {
          axis: axis === "x" ? "y" : "x",
          position: midCross,
          start: beforeStart + moving.size,
          end: a.start,
          kind: "spacing",
          spacingGap: Math.round(gap),
        },
        {
          axis: axis === "x" ? "y" : "x",
          position: midCross,
          start: a.start + a.size,
          end: b.start,
          kind: "spacing",
          spacingGap: Math.round(gap),
        },
      ];
    }
  }

  if (bestDelta === null) return null;
  return { delta: bestDelta, guides: bestGuides };
}

/**
 * Resolve dynamic smart-alignment and grid snapping for a dragged node or
 * multi-node bounding box in model coordinates. Alignment guides take
 * precedence over grid snapping on each axis; `bypass` disables both.
 */
export function resolveMermaidGfxMoveSnap({
  movingRect,
  candidates,
  gridEnabled,
  gridSize = MERMAID_GFX_GRID_SIZE,
  zoom = 1,
  bypass = false,
}: {
  readonly movingRect: Omit<MermaidGfxSnapRect, "id">;
  readonly candidates: readonly MermaidGfxSnapRect[];
  readonly gridEnabled: boolean;
  readonly gridSize?: number;
  readonly zoom?: number;
  readonly bypass?: boolean;
}): MermaidGfxMoveSnapResult {
  if (bypass) return { dx: 0, dy: 0, guides: [] };

  const tolerance = MERMAID_GFX_SNAP_TOLERANCE_PX / Math.max(zoom, 0.25);
  const xCandidates = candidates.map((rect) => ({
    start: rect.x,
    size: rect.width,
    crossStart: rect.y,
    crossEnd: rect.y + rect.height,
  }));
  const yCandidates = candidates.map((rect) => ({
    start: rect.y,
    size: rect.height,
    crossStart: rect.x,
    crossEnd: rect.x + rect.width,
  }));

  const movingX = {
    start: movingRect.x,
    size: movingRect.width,
    crossStart: movingRect.y,
    crossEnd: movingRect.y + movingRect.height,
  };
  const movingY = {
    start: movingRect.y,
    size: movingRect.height,
    crossStart: movingRect.x,
    crossEnd: movingRect.x + movingRect.width,
  };

  const xMatch =
    findAxisAlignment(movingX, xCandidates, "x", tolerance) ??
    findEqualSpacingMatch(movingX, xCandidates, "x", tolerance);
  const yMatch =
    findAxisAlignment(movingY, yCandidates, "y", tolerance) ??
    findEqualSpacingMatch(movingY, yCandidates, "y", tolerance);

  const dx = xMatch
    ? xMatch.delta
    : gridEnabled
      ? snapValueToMermaidGrid(movingRect.x, gridSize) - movingRect.x
      : 0;
  const dy = yMatch
    ? yMatch.delta
    : gridEnabled
      ? snapValueToMermaidGrid(movingRect.y, gridSize) - movingRect.y
      : 0;

  // Shift guide cross-axis spans by the resolved orthogonal delta so guide
  // lines stay glued to the snapped box corners.
  const guides: MermaidGfxSnapGuide[] = [
    ...(xMatch?.guides ?? []).map((guide) =>
      guide.axis === "x"
        ? {
            ...guide,
            start: Math.min(guide.start, movingRect.y + dy - GUIDE_OVERHANG_PX),
            end: Math.max(
              guide.end,
              movingRect.y + dy + movingRect.height + GUIDE_OVERHANG_PX,
            ),
          }
        : { ...guide, position: guide.position + dy },
    ),
    ...(yMatch?.guides ?? []).map((guide) =>
      guide.axis === "y"
        ? {
            ...guide,
            start: Math.min(guide.start, movingRect.x + dx - GUIDE_OVERHANG_PX),
            end: Math.max(
              guide.end,
              movingRect.x + dx + movingRect.width + GUIDE_OVERHANG_PX,
            ),
          }
        : { ...guide, position: guide.position + dx },
    ),
  ];

  return { dx, dy, guides };
}

/**
 * Resolve dynamic smart-alignment and grid snapping for bottom-right resize
 * gestures while preserving minimum dimensions.
 */
export function resolveMermaidGfxResizeSnap({
  rect,
  candidates,
  minWidth,
  minHeight,
  gridEnabled,
  gridSize = MERMAID_GFX_GRID_SIZE,
  zoom = 1,
  bypass = false,
}: {
  readonly rect: Omit<MermaidGfxSnapRect, "id">;
  readonly candidates: readonly MermaidGfxSnapRect[];
  readonly minWidth: number;
  readonly minHeight: number;
  readonly gridEnabled: boolean;
  readonly gridSize?: number;
  readonly zoom?: number;
  readonly bypass?: boolean;
}): MermaidGfxResizeSnapResult {
  if (bypass) {
    return {
      width: Math.max(minWidth, rect.width),
      height: Math.max(minHeight, rect.height),
      guides: [],
    };
  }

  const tolerance = MERMAID_GFX_SNAP_TOLERANCE_PX / Math.max(zoom, 0.25);
  const rawRight = rect.x + rect.width;
  const rawBottom = rect.y + rect.height;

  let bestRightDelta: number | null = null;
  let bestRightAbs = tolerance + 0.0001;
  let rightGuide: MermaidGfxSnapGuide | null = null;

  let bestBottomDelta: number | null = null;
  let bestBottomAbs = tolerance + 0.0001;
  let bottomGuide: MermaidGfxSnapGuide | null = null;

  for (const candidate of candidates) {
    for (const targetX of [candidate.x, candidate.x + candidate.width]) {
      const delta = targetX - rawRight;
      if (Math.abs(delta) < bestRightAbs && rect.width + delta >= minWidth) {
        bestRightAbs = Math.abs(delta);
        bestRightDelta = delta;
        rightGuide = {
          axis: "x",
          position: targetX,
          start: Math.min(rect.y, candidate.y) - GUIDE_OVERHANG_PX,
          end:
            Math.max(rect.y + rect.height, candidate.y + candidate.height) +
            GUIDE_OVERHANG_PX,
          kind: "align",
        };
      }
    }
    for (const targetY of [candidate.y, candidate.y + candidate.height]) {
      const delta = targetY - rawBottom;
      if (Math.abs(delta) < bestBottomAbs && rect.height + delta >= minHeight) {
        bestBottomAbs = Math.abs(delta);
        bestBottomDelta = delta;
        bottomGuide = {
          axis: "y",
          position: targetY,
          start: Math.min(rect.x, candidate.x) - GUIDE_OVERHANG_PX,
          end:
            Math.max(rect.x + rect.width, candidate.x + candidate.width) +
            GUIDE_OVERHANG_PX,
          kind: "align",
        };
      }
    }
  }

  const width = Math.max(
    minWidth,
    bestRightDelta !== null
      ? rect.width + bestRightDelta
      : gridEnabled
        ? snapValueToMermaidGrid(rect.width, gridSize)
        : rect.width,
  );
  const height = Math.max(
    minHeight,
    bestBottomDelta !== null
      ? rect.height + bestBottomDelta
      : gridEnabled
        ? snapValueToMermaidGrid(rect.height, gridSize)
        : rect.height,
  );

  const guides: MermaidGfxSnapGuide[] = [];
  if (rightGuide) guides.push(rightGuide);
  if (bottomGuide) guides.push(bottomGuide);
  return { width, height, guides };
}
