import type { CanvasRenderer, RoughCanvas } from "@virgultum/block-surface";
import {
  mermaidContourPoints,
  mermaidSoftShapePath,
  mermaidPersonGeometry,
  isMermaidShapeType,
  type LocalShapeElementModel,
  type ShapeElementModel,
  ShapeType,
} from "@virgultum/model";

import { type Colors } from "./utils.js";

type Point = [number, number];

function pathFromPoints(points: Point[]) {
  return `${points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
    .join(" ")} Z`;
}

function points(type: ShapeType, width: number, height: number): Point[] {
  if (type === ShapeType.MermaidPerson)
    return mermaidPersonGeometry(width, height).contour;
  const px = (value: number) => width * value;
  const py = (value: number) => height * value;
  switch (type) {
    case ShapeType.MermaidAsymmetric:
      return [
        [px(0), py(0)],
        [px(0.86), py(0)],
        [px(1), py(0.5)],
        [px(0.86), py(1)],
        [px(0), py(1)],
        [px(0.12), py(0.5)],
      ];
    case ShapeType.MermaidBolt:
      return [
        [px(0.6), py(0)],
        [px(0.28), py(0.46)],
        [px(0.48), py(0.46)],
        [px(0.36), py(1)],
        [px(0.74), py(0.36)],
        [px(0.54), py(0.36)],
      ];
    case ShapeType.MermaidBowRect:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.86), py(0.5)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0.14), py(0.5)],
      ];
    case ShapeType.MermaidTrapT:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.82), py(1)],
        [px(0.18), py(1)],
      ];
    case ShapeType.MermaidCurvTrap:
    case ShapeType.MermaidTrapB:
      return [
        [px(0.18), py(0)],
        [px(0.82), py(0)],
        [px(1), py(1)],
        [px(0), py(1)],
      ];
    case ShapeType.MermaidLeanL:
      return [
        [px(0), py(0)],
        [px(0.88), py(0)],
        [px(1), py(1)],
        [px(0.12), py(1)],
      ];
    case ShapeType.MermaidLeanR:
    case ShapeType.MermaidSlRect:
      return [
        [px(0.12), py(0)],
        [px(1), py(0)],
        [px(0.88), py(1)],
        [px(0), py(1)],
      ];
    case ShapeType.MermaidHexagon:
      return [
        [px(0.18), py(0)],
        [px(0.82), py(0)],
        [px(1), py(0.5)],
        [px(0.82), py(1)],
        [px(0.18), py(1)],
        [px(0), py(0.5)],
      ];
    case ShapeType.MermaidHourglass:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.55), py(0.5)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0.45), py(0.5)],
      ];
    case ShapeType.MermaidNotchPent:
      return [
        [px(0.2), py(0)],
        [px(1), py(0)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0), py(0.2)],
      ];
    case ShapeType.MermaidNotchRect:
      return [
        [px(0.12), py(0)],
        [px(1), py(0)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0), py(0.24)],
        [px(0.12), py(0.14)],
      ];
    case ShapeType.MermaidOdd:
      return [
        [px(0), py(0.12)],
        [px(1), py(0)],
        [px(1), py(0.82)],
        [px(0.18), py(1)],
        [px(0), py(0.74)],
      ];
    case ShapeType.MermaidFlipTri:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.5), py(1)],
      ];
    case ShapeType.MermaidFork:
      return [
        [px(0), py(0.38)],
        [px(1), py(0.38)],
        [px(1), py(0.62)],
        [px(0), py(0.62)],
      ];
    default:
      return [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ];
  }
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const radius = Math.min(w, h) * 0.28;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, radius);
}

function drawDelay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const radius = Math.min(w * 0.34, h / 2);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w - radius, 0);
  ctx.quadraticCurveTo(w, 0, w, radius);
  ctx.lineTo(w, h - radius);
  ctx.quadraticCurveTo(w, h, w - radius, h);
  ctx.lineTo(0, h);
  ctx.closePath();
}

function drawCylinder(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const ry = Math.min(16, h * 0.16);
  ctx.beginPath();
  ctx.ellipse(w / 2, ry, w / 2, ry, 0, Math.PI, 0);
  ctx.lineTo(w, h - ry);
  ctx.ellipse(w / 2, h - ry, w / 2, ry, 0, 0, Math.PI);
  ctx.closePath();
}

function drawDatastore(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(0, h * 0.16);
  ctx.lineTo(w, h * 0.16);
  ctx.moveTo(0, h * 0.84);
  ctx.lineTo(w, h * 0.84);
}

function drawHorizontalCylinder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  const rx = Math.min(24, w * 0.16);
  ctx.beginPath();
  ctx.ellipse(rx, h / 2, rx, h / 2, 0, Math.PI / 2, -Math.PI / 2);
  ctx.lineTo(w - rx, 0);
  ctx.ellipse(w - rx, h / 2, rx, h / 2, 0, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(rx, h);
  ctx.closePath();
}

function drawDocument(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const wave = Math.min(16, h * 0.16);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h - wave);
  ctx.quadraticCurveTo(w * 0.75, h + wave, w * 0.5, h - wave * 0.35);
  ctx.quadraticCurveTo(w * 0.25, h - wave * 1.6, 0, h - wave * 0.35);
  ctx.closePath();
}

function drawBrace(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  right: boolean,
) {
  const x = right ? w * 0.72 : w * 0.28;
  const dir = right ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.bezierCurveTo(
    x + dir * w * 0.24,
    0,
    x + dir * w * 0.24,
    h * 0.32,
    x,
    h * 0.4,
  );
  ctx.bezierCurveTo(
    x - dir * w * 0.12,
    h * 0.46,
    x - dir * w * 0.12,
    h * 0.54,
    x,
    h * 0.6,
  );
  ctx.bezierCurveTo(x + dir * w * 0.24, h * 0.68, x + dir * w * 0.24, h, x, h);
}

function drawMainPath(
  ctx: CanvasRenderingContext2D,
  type: ShapeType,
  w: number,
  h: number,
  contour: readonly Point[] = [],
) {
  switch (type) {
    case ShapeType.MermaidPerson: {
      const { head, body } = mermaidPersonGeometry(w, h);
      ctx.beginPath();
      ctx.roundRect(body.x, body.y, body.width, body.height, body.radius);
      // Match SVG's paint order: the head covers the body's overlapping border.
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(head.cx, head.cy, head.radius, 0, Math.PI * 2);
      return true;
    }
    case ShapeType.MermaidCylinder:
    case ShapeType.MermaidLinCyl:
      drawCylinder(ctx, w, h);
      return true;
    case ShapeType.MermaidDatastore:
      drawDatastore(ctx, w, h);
      return false;
    case ShapeType.MermaidHCyl:
      drawHorizontalCylinder(ctx, w, h);
      return true;
    case ShapeType.MermaidDoc:
    case ShapeType.MermaidDocs:
    case ShapeType.MermaidLinDoc:
    case ShapeType.MermaidTagDoc:
    case ShapeType.MermaidFlag:
      drawDocument(ctx, w, h);
      return true;
    case ShapeType.MermaidStadium:
      drawRoundedRect(ctx, w, h);
      return true;
    case ShapeType.MermaidDelay:
      drawDelay(ctx, w, h);
      return true;
    case ShapeType.MermaidCherryPick:
    case ShapeType.MermaidCrossCirc:
    case ShapeType.MermaidDoubleCircle:
    case ShapeType.MermaidFCirc:
    case ShapeType.MermaidFrCirc:
    case ShapeType.MermaidSmCirc:
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return true;
    case ShapeType.MermaidBrace:
      drawBrace(ctx, w, h, false);
      return false;
    case ShapeType.MermaidBraceR:
      drawBrace(ctx, w, h, true);
      return false;
    case ShapeType.MermaidBraces:
      drawBrace(ctx, w, h, false);
      ctx.stroke();
      drawBrace(ctx, w, h, true);
      return false;
    default: {
      const outline =
        type === ShapeType.MermaidBlockArrow && contour.length >= 3
          ? mermaidContourPoints(contour, { x: 0, y: 0, w, h })
          : points(type, w, h);
      ctx.beginPath();
      outline.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      return true;
    }
  }
}

function drawDetails(
  ctx: CanvasRenderingContext2D,
  type: ShapeType,
  w: number,
  h: number,
  innerCircleFill?: string,
) {
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  if (type === ShapeType.MermaidDocs || type === ShapeType.MermaidStRect) {
    line(w * 0.1, h * 0.1, w * 0.96, h * 0.1);
    line(w * 0.96, h * 0.1, w * 0.96, h * 0.86);
  }
  if (
    type === ShapeType.MermaidDivRect ||
    type === ShapeType.MermaidLinRect ||
    type === ShapeType.MermaidLinDoc
  ) {
    line(w * 0.18, 0, w * 0.18, h);
  }
  if (type === ShapeType.MermaidDivRect || type === ShapeType.MermaidWinPane) {
    line(0, h * 0.24, w, h * 0.24);
  }
  if (type === ShapeType.MermaidTagDoc || type === ShapeType.MermaidTagRect) {
    line(w * 0.72, 0, w * 0.88, h * 0.18);
    line(w * 0.88, h * 0.18, w, h * 0.18);
  }
  if (type === ShapeType.MermaidCylinder || type === ShapeType.MermaidLinCyl) {
    const ry = Math.min(16, h * 0.16);
    ctx.beginPath();
    ctx.ellipse(w / 2, ry, w / 2, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (type === ShapeType.MermaidLinCyl) {
    line(w * 0.18, h * 0.5, w * 0.82, h * 0.5);
  }
  if (type === ShapeType.MermaidHCyl) {
    const rx = Math.min(24, w * 0.16);
    ctx.beginPath();
    ctx.ellipse(w - rx, h / 2, rx, h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (
    type === ShapeType.MermaidFrRect ||
    type === ShapeType.MermaidSubroutine
  ) {
    line(w * 0.12, 0, w * 0.12, h);
    line(w * 0.88, 0, w * 0.88, h);
  }
  if (
    type === ShapeType.MermaidDoubleCircle ||
    type === ShapeType.MermaidFrCirc
  ) {
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w * 0.38, h * 0.38, 0, 0, Math.PI * 2);
    if (innerCircleFill) {
      ctx.fillStyle = innerCircleFill;
      ctx.fill();
    }
    ctx.stroke();
  }
  if (type === ShapeType.MermaidCherryPick) {
    for (const x of [0.35, 0.65]) {
      line(w * x, h * 0.6, w * 0.5, h * 0.25);
      ctx.beginPath();
      ctx.ellipse(w * x, h * 0.65, w * 0.1375, h * 0.1375, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (type === ShapeType.MermaidCrossCirc) {
    line(w * 0.3, h * 0.3, w * 0.7, h * 0.7);
    line(w * 0.7, h * 0.3, w * 0.3, h * 0.7);
  }
}

export function mermaidShape(
  model: ShapeElementModel | LocalShapeElementModel,
  ctx: CanvasRenderingContext2D,
  matrix: DOMMatrix,
  _renderer: CanvasRenderer,
  rc: RoughCanvas,
  colors: Colors,
) {
  if (!isMermaidShapeType(model.shapeType)) return;
  const {
    filled,
    rotate,
    roughness,
    seed,
    shapeStyle,
    strokeStyle,
    strokeWidth,
  } = model;
  const [, , rawW, rawH] = model.deserializedXYWH;
  const renderOffset =
    model.shapeType === ShapeType.MermaidPerson
      ? 0
      : Math.max(strokeWidth, 0) / 2;
  const w = rawW - renderOffset * 2;
  const h = rawH - renderOffset * 2;
  const cx = w / 2;
  const cy = h / 2;
  const { fillColor, strokeColor } = colors;

  ctx.setTransform(
    matrix
      .translateSelf(renderOffset, renderOffset)
      .translateSelf(cx, cy)
      .rotateSelf(rotate)
      .translateSelf(-cx, -cy),
  );
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = strokeStyle === "none" ? "transparent" : strokeColor;
  ctx.fillStyle =
    filled && model.shapeType !== ShapeType.MermaidText
      ? fillColor
      : "transparent";
  ctx.setLineDash(strokeStyle === "dash" ? [12, 12] : []);

  const softPath = mermaidSoftShapePath(model.shapeType, w, h);
  if (softPath) {
    const path = new Path2D(softPath);
    ctx.fill(path);
    if (model.shapeType === ShapeType.MermaidBang) {
      // Acute scallop joins must stay within the stroke-inset object bounds.
      ctx.save();
      ctx.lineJoin = "round";
      ctx.stroke(path);
      ctx.restore();
    } else ctx.stroke(path);
  } else if (
    shapeStyle !== "General" &&
    !model.shapeType.includes("brace") &&
    model.shapeType !== ShapeType.MermaidText
  ) {
    rc.path(
      pathFromPoints(
        model.shapeType === ShapeType.MermaidBlockArrow &&
          model.mermaidContour.length >= 3
          ? mermaidContourPoints(model.mermaidContour, { x: 0, y: 0, w, h })
          : points(model.shapeType, w, h),
      ),
      {
        seed,
        roughness,
        strokeLineDash: strokeStyle === "dash" ? [12, 12] : undefined,
        stroke: strokeStyle === "none" ? "none" : strokeColor,
        strokeWidth,
        fill: filled ? fillColor : undefined,
      },
    );
  } else {
    if (model.shapeType !== ShapeType.MermaidText) {
      const closed = drawMainPath(
        ctx,
        model.shapeType,
        w,
        h,
        model.mermaidContour,
      );
      if (closed) ctx.fill();
      ctx.stroke();
    }
  }

  drawDetails(
    ctx,
    model.shapeType,
    w,
    h,
    model.innerCircleFilled ? fillColor : undefined,
  );
  ctx.setLineDash([]);
}
