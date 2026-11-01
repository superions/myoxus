import {
  type CanvasRenderer,
  type ElementRenderer,
  ElementRendererExtension,
  type RoughCanvas,
} from "@virgultum/block-surface";
import {
  getFontMetrics,
  getFontString,
  getLineWidth,
  isRTL,
  measureTextInDOM,
  wrapTextDeltas,
} from "@virgultum/gfx-text";
import { Bound, type IBound } from "@virgultum/global/gfx";
import {
  DefaultTheme,
  getMermaidSubgraphCollapsePoints,
  type LocalShapeElementModel,
  type ShapeElementModel,
  type ShapeType,
  TextAlign,
} from "@virgultum/model";
import { deltaInsertsToChunks } from "@virgultum/std/inline";

import { diamond } from "./diamond.js";
import { ellipse } from "./ellipse.js";
import { mermaidShape } from "./mermaid.js";
import { rect } from "./rect.js";
import { triangle } from "./triangle.js";
import { renderProjectedShapeLabel } from "../label-projection.js";
import { type Colors, horizontalOffset, verticalOffset } from "./utils.js";

const shapeRenderers: Record<
  ShapeType,
  (
    model: ShapeElementModel | LocalShapeElementModel,
    ctx: CanvasRenderingContext2D,
    matrix: DOMMatrix,
    renderer: CanvasRenderer,
    rc: RoughCanvas,
    colors: Colors,
  ) => void
> = {
  diamond,
  rect,
  triangle,
  ellipse,

  // Mermaid flowchart shapes
  "mermaid-asymmetric": mermaidShape,
  "mermaid-bang": mermaidShape,
  "mermaid-bolt": mermaidShape,
  "mermaid-bow-rect": mermaidShape,
  "mermaid-brace": mermaidShape,
  "mermaid-brace-r": mermaidShape,
  "mermaid-braces": mermaidShape,
  "mermaid-cloud": mermaidShape,
  "mermaid-cherry-pick": mermaidShape,
  "mermaid-cross-circ": mermaidShape,
  "mermaid-curv-trap": mermaidShape,
  "mermaid-cylinder": mermaidShape,
  "mermaid-datastore": mermaidShape,
  "mermaid-delay": mermaidShape,
  "mermaid-div-rect": mermaidShape,
  "mermaid-doc": mermaidShape,
  "mermaid-docs": mermaidShape,
  "mermaid-double-circle": mermaidShape,
  "mermaid-f-circ": mermaidShape,
  "mermaid-flag": mermaidShape,
  "mermaid-flip-tri": mermaidShape,
  "mermaid-fork": mermaidShape,
  "mermaid-block-arrow": mermaidShape,
  "mermaid-fr-circ": mermaidShape,
  "mermaid-fr-rect": mermaidShape,
  "mermaid-h-cyl": mermaidShape,
  "mermaid-person": mermaidShape,
  "mermaid-hexagon": mermaidShape,
  "mermaid-hourglass": mermaidShape,
  "mermaid-lean-l": mermaidShape,
  "mermaid-lean-r": mermaidShape,
  "mermaid-lin-cyl": mermaidShape,
  "mermaid-lin-doc": mermaidShape,
  "mermaid-lin-rect": mermaidShape,
  "mermaid-notch-pent": mermaidShape,
  "mermaid-notch-rect": mermaidShape,
  "mermaid-odd": mermaidShape,
  "mermaid-sl-rect": mermaidShape,
  "mermaid-sm-circ": mermaidShape,
  "mermaid-st-rect": mermaidShape,
  "mermaid-stadium": mermaidShape,
  "mermaid-subroutine": mermaidShape,
  "mermaid-tag-doc": mermaidShape,
  "mermaid-tag-rect": mermaidShape,
  "mermaid-text": mermaidShape,
  "mermaid-trap-b": mermaidShape,
  "mermaid-trap-t": mermaidShape,
  "mermaid-win-pane": mermaidShape,
};

export const shape: ElementRenderer<ShapeElementModel> = (
  model,
  ctx,
  matrix,
  renderer,
  rc,
) => {
  const color = renderer.getColorValue(
    model.color,
    DefaultTheme.shapeTextColor,
    true,
  );
  const fillColor = renderer.getColorValue(
    model.fillColor,
    DefaultTheme.shapeFillColor,
    true,
  );
  const strokeColor = renderer.getColorValue(
    model.strokeColor,
    DefaultTheme.shapeStrokeColor,
    true,
  );
  const colors = { color, fillColor, strokeColor };

  shapeRenderers[model.shapeType](model, ctx, matrix, renderer, rc, colors);

  if (model.textDisplay) {
    renderText(model, ctx, colors);
  }
  const chrome = getMermaidSubgraphCollapsePoints(model);
  if (chrome.length) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(model.strokeWidth, 1);
    ctx.beginPath();
    chrome.forEach(([x, y], index) =>
      index
        ? ctx.lineTo(x - model.x, y - model.y)
        : ctx.moveTo(x - model.x, y - model.y),
    );
    ctx.stroke();
    ctx.restore();
  }
};

export const ShapeElementRendererExtension = ElementRendererExtension(
  "shape",
  shape,
);

export * from "./utils";

function renderText(
  model: ShapeElementModel | LocalShapeElementModel,
  ctx: CanvasRenderingContext2D,
  { color }: Colors,
) {
  const {
    x,
    y,
    text,
    fontSize,
    fontFamily,
    fontWeight,
    textAlign,
    w,
    h,
    textVerticalAlign,
    padding,
  } = model;
  if (model.labelProjection) {
    renderProjectedShapeLabel(model, ctx, color);
    return;
  }
  if (!text) return;

  const [verticalPadding, horPadding] = padding;
  const font = getFontString(model);
  const { lineGap, lineHeight } = measureTextInDOM(
    fontFamily,
    fontSize,
    fontWeight,
  );
  const metrics = getFontMetrics(fontFamily, fontSize, fontWeight);
  const renderedLineHeight = lineHeight + lineGap;
  const lines =
    typeof text === "string"
      ? text.split("\n").map((line) => [{ insert: line }])
      : deltaInsertsToChunks(wrapTextDeltas(text, font, w - horPadding * 2));
  const horOffset = horizontalOffset(model.w, model.textAlign, horPadding);
  const textBlockTop = verticalOffset(
    lines,
    renderedLineHeight,
    h,
    textVerticalAlign,
    verticalPadding,
  );
  const vertOffset = textBlockTop + metrics.fontBoundingBoxAscent + lineGap / 2;
  let maxLineWidth = 0;

  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = textAlign;
  ctx.textBaseline = "alphabetic";

  for (const [lineIndex, line] of lines.entries()) {
    for (const delta of line) {
      const str = delta.insert;
      const rtl = isRTL(str);
      const shouldTemporarilyAttach = rtl && !ctx.canvas.isConnected;
      if (shouldTemporarilyAttach) {
        // to correctly render RTL text mixed with LTR, we have to append it
        // to the DOM
        document.body.append(ctx.canvas);
      }

      if (ctx.canvas.dir !== (rtl ? "rtl" : "ltr")) {
        ctx.canvas.setAttribute("dir", rtl ? "rtl" : "ltr");
      }

      ctx.fillText(
        str,
        // 0.5 is the dom editor padding to make the text align with the DOM text
        horOffset + 0.5,
        lineIndex * renderedLineHeight + vertOffset,
      );

      const lineWidth = getLineWidth(str, font);
      if (model.textDecoration === "underline") {
        const left =
          model.textAlign === TextAlign.Center
            ? horOffset - lineWidth / 2
            : model.textAlign === TextAlign.Right
              ? horOffset - lineWidth
              : horOffset;
        ctx.fillRect(
          left + 0.5,
          lineIndex * renderedLineHeight +
            vertOffset +
            metrics.fontBoundingBoxDescent / 2,
          lineWidth,
          Math.max(1, fontSize / 14),
        );
      }
      maxLineWidth = Math.max(maxLineWidth, lineWidth);

      if (shouldTemporarilyAttach) {
        ctx.canvas.remove();
      }
    }
  }

  const offsetX =
    model.textAlign === TextAlign.Center
      ? (w - maxLineWidth) / 2
      : model.textAlign === TextAlign.Left
        ? horOffset
        : horOffset - maxLineWidth;
  const bound = new Bound(
    x + offsetX,
    y + textBlockTop,
    maxLineWidth,
    renderedLineHeight * lines.length,
  ) as IBound;

  bound.rotate = model.rotate ?? 0;
  model.textBound = bound;
}
