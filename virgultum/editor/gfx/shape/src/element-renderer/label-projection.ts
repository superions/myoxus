// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  getFontMetrics,
  getFontString,
  getLineWidth,
  isRTL,
} from "@virgultum/gfx-text";
import { Bound, type IBound } from "@virgultum/global/gfx";
import { TextUtils } from "@virgultum/block-surface";
import type {
  ShapeElementModel,
  LocalShapeElementModel,
} from "@virgultum/model";

type LabelModel = ShapeElementModel | LocalShapeElementModel;

/** Both native renderers consume the already wrapped, source-derived runs. No
 * renderer rewrites Y.Text, shrinks fonts or independently wraps the label. */
function labelLines(model: LabelModel) {
  const projection = model.labelProjection!;
  const lines: {
    text: string;
    font: string;
    width: number;
    fontWeight: string;
    fontStyle: string;
  }[][] = [[]];
  for (const run of projection.runs) {
    const fontWeight = run.bold ? "bold" : model.fontWeight;
    const fontStyle = run.italic ? "italic" : model.fontStyle;
    const font = getFontString({
      fontSize: model.fontSize,
      fontFamily: model.fontFamily,
      fontWeight,
      fontStyle,
    });
    run.text.split("\n").forEach((text, index) => {
      if (index) lines.push([]);
      lines.at(-1)!.push({
        text,
        font,
        width: getLineWidth(text, font),
        fontWeight,
        fontStyle,
      });
    });
  }
  const { box, lineHeight } = projection;
  const top = box.y + (box.height - lines.length * lineHeight) / 2;
  return lines.map((runs, index) => {
    const width = runs.reduce((width, run) => width + run.width, 0);
    const metrics = runs.map((run) =>
      getFontMetrics(model.fontFamily, model.fontSize, run.fontWeight),
    );
    const ascent = Math.max(
      0,
      ...metrics.map((metric) => metric.fontBoundingBoxAscent),
    );
    const descent = Math.max(
      0,
      ...metrics.map((metric) => metric.fontBoundingBoxDescent),
    );
    return {
      runs,
      width,
      x: box.x + (box.width - width) / 2,
      y:
        top + index * lineHeight + (lineHeight - ascent - descent) / 2 + ascent,
    };
  });
}

export function renderProjectedShapeLabel(
  model: LabelModel,
  ctx: CanvasRenderingContext2D,
  color: string,
) {
  const projection = model.labelProjection!;
  const lines = labelLines(model);
  ctx.save();
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const line of lines) {
    let x = line.x;
    for (const run of line.runs) {
      ctx.font = run.font;
      ctx.direction = isRTL(run.text) ? "rtl" : "ltr";
      ctx.textAlign = isRTL(run.text) ? "right" : "left";
      // Explicit run advance is shared with the SVG renderer; RTL runs end at
      // their right edge while retaining source order within the measured line.
      ctx.fillText(run.text, isRTL(run.text) ? x + run.width : x, line.y);
      if (model.textDecoration === "underline")
        ctx.fillRect(
          x,
          line.y + model.fontSize / 8,
          run.width,
          Math.max(1, model.fontSize / 14),
        );
      x += run.width;
    }
  }
  const icon = projection.icon;
  if (icon) {
    const [vx, vy, vw, vh] = icon.viewBox;
    ctx.translate(icon.x, icon.y);
    ctx.scale(icon.size / vw, icon.size / vh);
    ctx.translate(-vx, -vy);
    ctx.lineWidth = icon.strokeWidth;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.setLineDash([]);
    for (const path of icon.paths) ctx.stroke(new Path2D(path));
  }
  ctx.restore();
  const { box } = projection;
  const bound = new Bound(
    model.x + box.x,
    model.y + box.y,
    box.width,
    box.height,
  );
  (bound as IBound).rotate = model.rotate;
  model.textBound = bound;
}

export function projectedShapeLabelSvg(model: LabelModel, color: string) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${model.w} ${model.h}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.pointerEvents = "none";
  svg.setAttribute("fill", color);
  for (const line of labelLines(model)) {
    let x = line.x;
    for (const run of line.runs) {
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", String(isRTL(run.text) ? x + run.width : x));
      text.setAttribute("y", String(line.y));
      text.setAttribute("direction", isRTL(run.text) ? "rtl" : "ltr");
      text.setAttribute(
        "font-family",
        TextUtils.getFontFamilyName(model.fontFamily),
      );
      text.setAttribute("font-size", String(model.fontSize));
      text.setAttribute("font-weight", run.fontWeight);
      text.setAttribute("font-style", run.fontStyle);
      text.setAttribute("text-decoration", model.textDecoration);
      text.style.whiteSpace = "pre";
      text.textContent = run.text;
      svg.append(text);
      x += run.width;
    }
  }
  const icon = model.labelProjection!.icon;
  if (icon) {
    const [vx, vy, vw, vh] = icon.viewBox;
    const group = document.createElementNS(ns, "g");
    group.setAttribute(
      "transform",
      `translate(${icon.x} ${icon.y}) scale(${icon.size / vw} ${icon.size / vh}) translate(${-vx} ${-vy})`,
    );
    group.setAttribute("fill", "none");
    group.setAttribute("stroke", color);
    group.setAttribute("stroke-width", String(icon.strokeWidth));
    group.setAttribute("stroke-linecap", "round");
    group.setAttribute("stroke-linejoin", "round");
    for (const d of icon.paths) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      group.append(path);
    }
    svg.append(group);
  }
  return svg;
}
