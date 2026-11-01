import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { ToolbarControl } from "@virgultum/shared/services";

import {
  autoArrangeElementsCommand,
  autoResizeElementsCommand,
  EdgelessCRUDIdentifier,
  updateXYWH,
} from "@virgultum/block-surface";

import { Bound } from "@virgultum/global/gfx";
import { type ToolbarContext, editorMessage } from "@virgultum/shared/services";
import type { GfxModel } from "@virgultum/std/gfx";

enum Alignment {
  None,
  AutoArrange,
  AutoResize,
  Bottom,
  DistributeHorizontally,
  DistributeVertically,
  Horizontally,
  Left,
  Right,
  Top,
  Vertically,
}

type AlignmentMap = Record<
  Alignment,
  (ctx: ToolbarContext, elements: GfxModel[]) => void
>;

const HORIZONTAL_ALIGNMENT = [
  {
    key: editorMessage("com.myoxus.keyboardShortcuts.alignLeft", "Align left"),
    value: Alignment.Left,
    icon: "AlignLeftIcon",
  },
  {
    key: editorMessage(
      "com.myoxus.editor.align.horizontal",
      "Align horizontally",
    ),
    value: Alignment.Horizontally,
    icon: "AlignHorizontalCenterIcon",
  },
  {
    key: editorMessage(
      "com.myoxus.keyboardShortcuts.alignRight",
      "Align right",
    ),
    value: Alignment.Right,
    icon: "AlignRightIcon",
  },
  {
    key: editorMessage(
      "com.myoxus.editor.align.distribute-horizontal",
      "Distribute horizontally",
    ),
    value: Alignment.DistributeHorizontally,
    icon: "DistributeHorizontalIcon",
  },
] as const satisfies {
  key: ReturnType<typeof editorMessage>;
  value: Alignment;
  icon: MyoxusIconExportName;
}[];

const VERTICAL_ALIGNMENT = [
  {
    key: editorMessage("com.myoxus.editor.align.top", "Align top"),
    value: Alignment.Top,
    icon: "AlignTopIcon",
  },
  {
    key: editorMessage("com.myoxus.editor.align.vertical", "Align vertically"),
    value: Alignment.Vertically,
    icon: "AlignVerticalCenterIcon",
  },
  {
    key: editorMessage("com.myoxus.editor.align.bottom", "Align bottom"),
    value: Alignment.Bottom,
    icon: "AlignBottomIcon",
  },
  {
    key: editorMessage(
      "com.myoxus.editor.align.distribute-vertical",
      "Distribute vertically",
    ),
    value: Alignment.DistributeVertically,
    icon: "DistributeVerticalIcon",
  },
] as const satisfies {
  key: ReturnType<typeof editorMessage>;
  value: Alignment;
  icon: MyoxusIconExportName;
}[];

const AUTO_ALIGNMENT = [
  {
    key: editorMessage("com.myoxus.editor.align.auto-arrange", "Auto arrange"),
    value: Alignment.AutoArrange,
    icon: "AutoTidyUpIcon",
  },
  {
    key: editorMessage("com.myoxus.editor.align.resize", "Resize & Align"),
    value: Alignment.AutoResize,
    icon: "ResizeTidyUpIcon",
  },
] as const satisfies {
  key: ReturnType<typeof editorMessage>;
  value: Alignment;
  icon: MyoxusIconExportName;
}[];

const alignment = {
  // None: do nothing
  [Alignment.None]() {},

  // Horizontal
  [Alignment.Left](ctx: ToolbarContext, elements: GfxModel[]) {
    const bounds = elements.map((a) => a.elementBound);
    const left = Math.min(...bounds.map((b) => b.minX));

    for (const [index, element] of elements.entries()) {
      const elementBound = bounds[index];
      const bound = Bound.deserialize(element.xywh);
      const offset = bound.minX - elementBound.minX;
      bound.x = left + offset;

      updateXYWHWith(ctx, element, bound);
    }
  },

  [Alignment.Horizontally](ctx: ToolbarContext, elements: GfxModel[]) {
    const bounds = elements.map((a) => a.elementBound);
    const left = Math.min(...bounds.map((b) => b.minX));
    const right = Math.max(...bounds.map((b) => b.maxX));
    const centerX = (left + right) / 2;

    for (const element of elements) {
      const bound = Bound.deserialize(element.xywh);
      bound.x = centerX - bound.w / 2;

      updateXYWHWith(ctx, element, bound);
    }
  },

  [Alignment.Right](ctx: ToolbarContext, elements: GfxModel[]) {
    const bounds = elements.map((a) => a.elementBound);
    const right = Math.max(...bounds.map((b) => b.maxX));

    for (const [i, element] of elements.entries()) {
      const elementBound = bounds[i];
      const bound = Bound.deserialize(element.xywh);
      const offset = bound.maxX - elementBound.maxX;
      bound.x = right - bound.w + offset;

      updateXYWHWith(ctx, element, bound);
    }
  },

  [Alignment.DistributeHorizontally](
    ctx: ToolbarContext,
    elements: GfxModel[],
  ) {
    elements.sort((a, b) => a.elementBound.minX - b.elementBound.minX);
    const bounds = elements.map((a) => a.elementBound);
    const left = bounds[0].minX;
    const right = bounds[bounds.length - 1].maxX;

    const totalWidth = right - left;
    const totalGap =
      totalWidth - elements.reduce((prev, ele) => prev + ele.elementBound.w, 0);
    const gap = totalGap / (elements.length - 1);
    let next = bounds[0].maxX + gap;

    for (let i = 1; i < elements.length - 1; i++) {
      const bound = Bound.deserialize(elements[i].xywh);
      bound.x = next + bounds[i].w / 2 - bound.w / 2;
      next += gap + bounds[i].w;

      updateXYWHWith(ctx, elements[i], bound);
    }
  },

  // Vertical
  [Alignment.Top](ctx: ToolbarContext, elements: GfxModel[]) {
    const bounds = elements.map((a) => a.elementBound);
    const top = Math.min(...bounds.map((b) => b.minY));

    for (const [i, element] of elements.entries()) {
      const elementBound = bounds[i];
      const bound = Bound.deserialize(element.xywh);
      const offset = bound.minY - elementBound.minY;
      bound.y = top + offset;

      updateXYWHWith(ctx, element, bound);
    }
  },

  [Alignment.Vertically](ctx: ToolbarContext, elements: GfxModel[]) {
    const bounds = elements.map((a) => a.elementBound);
    const top = Math.min(...bounds.map((b) => b.minY));
    const bottom = Math.max(...bounds.map((b) => b.maxY));
    const centerY = (top + bottom) / 2;

    for (const element of elements) {
      const bound = Bound.deserialize(element.xywh);
      bound.y = centerY - bound.h / 2;

      updateXYWHWith(ctx, element, bound);
    }
  },

  [Alignment.Bottom](ctx: ToolbarContext, elements: GfxModel[]) {
    const bounds = elements.map((a) => a.elementBound);
    const bottom = Math.max(...bounds.map((b) => b.maxY));

    for (const [i, element] of elements.entries()) {
      const elementBound = bounds[i];
      const bound = Bound.deserialize(element.xywh);
      const offset = bound.maxY - elementBound.maxY;
      bound.y = bottom - bound.h + offset;

      updateXYWHWith(ctx, element, bound);
    }
  },

  [Alignment.DistributeVertically](ctx: ToolbarContext, elements: GfxModel[]) {
    elements.sort((a, b) => a.elementBound.minY - b.elementBound.minY);
    const bounds = elements.map((a) => a.elementBound);
    const top = bounds[0].minY;
    const bottom = bounds[bounds.length - 1].maxY;

    const totalHeight = bottom - top;
    const totalGap =
      totalHeight -
      elements.reduce((prev, ele) => prev + ele.elementBound.h, 0);
    const gap = totalGap / (elements.length - 1);
    let next = bounds[0].maxY + gap;
    for (let i = 1; i < elements.length - 1; i++) {
      const bound = Bound.deserialize(elements[i].xywh);
      bound.y = next + bounds[i].h / 2 - bound.h / 2;
      next += gap + bounds[i].h;

      updateXYWHWith(ctx, elements[i], bound);
    }
  },

  // Auto
  [Alignment.AutoArrange](ctx: ToolbarContext) {
    ctx.command.exec(autoArrangeElementsCommand);
  },

  [Alignment.AutoResize](ctx: ToolbarContext) {
    ctx.command.exec(autoResizeElementsCommand);
  },
} as const satisfies AlignmentMap;

const updateXYWHWith = (ctx: ToolbarContext, model: GfxModel, bound: Bound) => {
  updateXYWH(
    model,
    bound,
    ctx.std.get(EdgelessCRUDIdentifier).updateElement,
    ctx.store.updateBlock,
  );
};

export function alignmentControl(
  ctx: ToolbarContext,
  models: GfxModel[],
): ToolbarControl {
  return {
    type: "menu",
    items: [HORIZONTAL_ALIGNMENT, VERTICAL_ALIGNMENT, AUTO_ALIGNMENT].map(
      (items, index) => ({
        id: String(index),
        actions: items.map((item) => ({
          id: String(item.value),
          label: item.key,
          icon: item.icon,
          run: () => alignment[item.value](ctx, models),
        })),
      }),
    ),
  };
}
