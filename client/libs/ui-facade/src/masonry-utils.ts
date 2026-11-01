// SPDX-License-Identifier: MIT

import type {
  MasonryGroup,
  MasonryItem,
  MasonryItemXYWH,
  MasonryPX,
} from "./masonry-types";

/** Minimum measured-card widths in CSS pixels; column calculation must not undershoot them. */
export const measuredCardWidthMinimum = {
  compact: 240,
  normal: 320,
  large: 480,
} as const;

export const calcPX = (px: MasonryPX, totalWidth: number) =>
  typeof px === "number" ? px : px(totalWidth);

export const calcColumns = (
  totalWidth: number,
  itemWidth: number | "stretch",
  itemWidthMin: number,
  gapX: number,
  _paddingX: MasonryPX,
  columns?: number,
) => {
  const paddingX = calcPX(_paddingX, totalWidth);
  const availableWidth = Math.max(1, totalWidth - paddingX * 2);

  if (columns) {
    const safeColumns = Math.max(1, columns);
    const width = Math.max(
      1,
      (availableWidth - (safeColumns - 1) * gapX) / safeColumns,
    );
    return { columns: safeColumns, width };
  }

  if (itemWidth === "stretch") {
    let calculatedColumns = 1;
    while (
      calculatedColumns * itemWidthMin + (calculatedColumns - 1) * gapX <
      availableWidth
    ) {
      calculatedColumns++;
    }
    const finalColumns = Math.max(1, calculatedColumns - 1);
    const finalWidth = Math.max(
      1,
      (availableWidth - (finalColumns - 1) * gapX) / finalColumns,
    );
    return {
      columns: finalColumns,
      width: finalWidth,
    };
  }

  let calculatedColumns = 1;
  while (
    calculatedColumns * itemWidth + (calculatedColumns - 1) * gapX <
    availableWidth
  ) {
    calculatedColumns++;
  }
  return {
    columns: Math.max(1, calculatedColumns - 1),
    width: itemWidth,
  };
};

export const calcLayout = (
  groups: MasonryGroup[],
  options: {
    totalWidth: number;
    columns: number;
    width: number;
    gapX: number;
    gapY: number;
    paddingX: MasonryPX;
    paddingY: number;
    groupsGap: number;
    groupHeaderGapWithItems: number;
    collapsedGroups: string[];
    layoutMode?: "masonry" | "grid";
    measuredHeights?: ReadonlyMap<string, number>;
  },
) => {
  const {
    totalWidth,
    columns,
    width,
    gapX,
    gapY,
    paddingX: _paddingX,
    paddingY,
    groupsGap,
    groupHeaderGapWithItems,
    collapsedGroups,
    layoutMode = "masonry",
    measuredHeights,
  } = options;
  const paddingX = calcPX(_paddingX, totalWidth);

  const layout = new Map<string, MasonryItemXYWH>();
  let finalHeight = paddingY;

  groups.forEach((group, index) => {
    const heightStack = Array.from({ length: columns }, () => 0);
    const ratioStack = Array.from({ length: columns }, () => 0);
    let rowHeight = 0;
    let rowTop = 0;
    if (index !== 0) {
      finalHeight += groupsGap;
    }

    const groupHeaderLayout: MasonryItemXYWH = {
      type: "group",
      x: 0,
      y: finalHeight,
      w: totalWidth,
      h: group.height,
    };
    layout.set(group.id, groupHeaderLayout);

    if (collapsedGroups.includes(group.id)) {
      finalHeight += groupHeaderLayout.h;
      return;
    }

    finalHeight +=
      groupHeaderLayout.h +
      (groupHeaderLayout.h > 0 ? groupHeaderGapWithItems : 0);

    group.items.forEach((item, itemIndex) => {
      const itemId = group.id ? `${group.id}:${item.id}` : item.id;
      const ratioMode = "ratio" in item;
      // An unmeasured item reserves one column width until its mounted child
      // reports the actual height; explicit ratio/height items never change.
      const height = ratioMode
        ? item.ratio * width
        : "height" in item
          ? item.height
          : (measuredHeights?.get(itemId) ?? width);
      const aroundGapXValue =
        columns > 1
          ? (totalWidth - paddingX * 2 - width * columns) / (columns - 1)
          : 0;
      const gapXValue = Math.max(gapX, aroundGapXValue);

      if (layoutMode === "grid") {
        const column = itemIndex % columns;
        if (column === 0 && itemIndex > 0) {
          rowTop += rowHeight + gapY;
          rowHeight = 0;
        }
        const x = column * (width + gapXValue) + paddingX;
        layout.set(itemId, {
          type: "item",
          x,
          y: finalHeight + rowTop,
          w: width,
          h: height,
        });
        rowHeight = Math.max(rowHeight, height);
      } else if (ratioMode) {
        const minRatio = Math.min(...ratioStack);
        const minRatioIndex = ratioStack.indexOf(minRatio);
        const minHeight = heightStack[minRatioIndex] ?? 0;
        const hasGap = minHeight ? gapY : 0;
        const x = minRatioIndex * (width + gapXValue) + paddingX;
        const y = finalHeight + minHeight + hasGap;

        ratioStack[minRatioIndex] =
          (ratioStack[minRatioIndex] ?? 0) + item.ratio * 10000;
        heightStack[minRatioIndex] = minHeight + height + hasGap;
        layout.set(itemId, { type: "item", x, y, w: width, h: height });
      } else {
        const minHeight = Math.min(...heightStack);
        const minHeightIndex = heightStack.indexOf(minHeight);
        const hasGap = minHeight ? gapY : 0;
        const x = minHeightIndex * (width + gapXValue) + paddingX;
        const y = finalHeight + minHeight + hasGap;
        const ratio = height / width;

        heightStack[minHeightIndex] = minHeight + height + hasGap;
        ratioStack[minHeightIndex] =
          (ratioStack[minHeightIndex] ?? 0) + ratio * 10000;
        layout.set(itemId, { type: "item", x, y, w: width, h: height });
      }
    });

    finalHeight +=
      (layoutMode === "grid" ? rowTop + rowHeight : Math.max(...heightStack)) +
      paddingY;
  });

  return { layout, height: finalHeight };
};

export const calcActive = (options: {
  viewportHeight: number;
  scrollY: number;
  layoutMap: Map<MasonryItem["id"], MasonryItemXYWH>;
  preloadHeight: number;
}) => {
  const { viewportHeight, scrollY, layoutMap, preloadHeight } = options;
  const activeMap = new Map<MasonryItem["id"], boolean>();

  layoutMap.forEach((layout, id) => {
    const { y, h } = layout;
    if (
      y + h + preloadHeight > scrollY &&
      y - preloadHeight < scrollY + viewportHeight
    ) {
      activeMap.set(id, true);
    }
  });

  return activeMap;
};

export const calcSticky = (options: {
  scrollY: number;
  layoutMap: Map<MasonryItem["id"], MasonryItemXYWH>;
}) => {
  const { scrollY, layoutMap } = options;
  const entries = Array.from(layoutMap.entries());
  const groupEntries = entries.filter(([, layout]) => layout.type === "group");
  const stickyGroupEntry = groupEntries.find(([, xywh], index) => {
    const next = groupEntries[index + 1];
    return xywh.y <= scrollY && (!next || next[1].y > scrollY);
  });

  return stickyGroupEntry
    ? stickyGroupEntry[0]
    : groupEntries.length > 0
      ? groupEntries[0]?.[0]
      : "";
};
