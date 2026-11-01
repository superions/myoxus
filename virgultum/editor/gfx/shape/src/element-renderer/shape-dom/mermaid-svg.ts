import {
  mermaidContourPoints,
  mermaidSoftShapePath,
  mermaidPersonGeometry,
  isMermaidShapeType,
  type ShapeElementModel,
  ShapeType,
} from "@virgultum/model";

const SVG_NS = "http://www.w3.org/2000/svg";

type Point = [number, number];

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

function points(type: ShapeType, w: number, h: number): Point[] {
  if (type === ShapeType.MermaidPerson)
    return mermaidPersonGeometry(w, h).contour;
  const px = (value: number) => w * value;
  const py = (value: number) => h * value;
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
        [w, 0],
        [w, h],
        [0, h],
      ];
  }
}

function pointString(points: Point[]) {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function pathFor(type: ShapeType, w: number, h: number) {
  const softPath = mermaidSoftShapePath(type, w, h);
  if (softPath) return softPath;
  switch (type) {
    case ShapeType.MermaidDelay: {
      const radius = Math.min(w * 0.34, h / 2);
      return `M 0 0 L ${w - radius} 0 Q ${w} 0, ${w} ${radius} L ${w} ${h - radius} Q ${w} ${h}, ${w - radius} ${h} L 0 ${h} Z`;
    }
    case ShapeType.MermaidDatastore:
      return `M 0 ${h * 0.16} L ${w} ${h * 0.16} M 0 ${h * 0.84} L ${w} ${h * 0.84}`;
    case ShapeType.MermaidHCyl: {
      const rx = Math.min(24, w * 0.16);
      return `M ${rx} 0 L ${w - rx} 0 A ${rx} ${h / 2} 0 0 1 ${w - rx} ${h} L ${rx} ${h} A ${rx} ${h / 2} 0 0 1 ${rx} 0 Z`;
    }
    case ShapeType.MermaidDoc:
    case ShapeType.MermaidDocs:
    case ShapeType.MermaidLinDoc:
    case ShapeType.MermaidTagDoc:
    case ShapeType.MermaidFlag: {
      const wave = Math.min(16, h * 0.16);
      return `M 0 0 L ${w} 0 L ${w} ${h - wave} Q ${w * 0.75} ${h + wave}, ${w * 0.5} ${h - wave * 0.35} Q ${w * 0.25} ${h - wave * 1.6}, 0 ${h - wave * 0.35} Z`;
    }
    case ShapeType.MermaidBrace:
      return `M ${w * 0.28} 0 C ${w * 0.04} 0, ${w * 0.04} ${h * 0.32}, ${w * 0.28} ${h * 0.4} C ${w * 0.4} ${h * 0.46}, ${w * 0.4} ${h * 0.54}, ${w * 0.28} ${h * 0.6} C ${w * 0.04} ${h * 0.68}, ${w * 0.04} ${h}, ${w * 0.28} ${h}`;
    case ShapeType.MermaidBraceR:
      return `M ${w * 0.72} 0 C ${w * 0.96} 0, ${w * 0.96} ${h * 0.32}, ${w * 0.72} ${h * 0.4} C ${w * 0.6} ${h * 0.46}, ${w * 0.6} ${h * 0.54}, ${w * 0.72} ${h * 0.6} C ${w * 0.96} ${h * 0.68}, ${w * 0.96} ${h}, ${w * 0.72} ${h}`;
    default:
      return "";
  }
}

function appendDetails(
  svg: SVGSVGElement,
  type: ShapeType,
  w: number,
  h: number,
  stroke: string,
  innerCircleFill?: string,
) {
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    svg.append(
      el("line", {
        x1: String(x1),
        y1: String(y1),
        x2: String(x2),
        y2: String(y2),
        stroke,
        "stroke-width": "2",
      }),
    );
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
  if (type === ShapeType.MermaidDatastore || type === ShapeType.MermaidLinCyl) {
    if (type === ShapeType.MermaidDatastore) return;
    line(w * 0.18, h * 0.5, w * 0.82, h * 0.5);
  }
  if (type === ShapeType.MermaidHCyl) {
    const rx = Math.min(24, w * 0.16);
    svg.append(
      el("ellipse", {
        cx: String(w - rx),
        cy: String(h / 2),
        rx: String(rx),
        ry: String(h / 2),
        fill: "none",
        stroke,
        "stroke-width": "2",
      }),
    );
  }
  if (type === ShapeType.MermaidCylinder || type === ShapeType.MermaidLinCyl) {
    const ry = Math.min(16, h * 0.16);
    svg.append(
      el("ellipse", {
        cx: String(w / 2),
        cy: String(ry),
        rx: String(w / 2),
        ry: String(ry),
        fill: "none",
        stroke,
        "stroke-width": "2",
      }),
    );
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
    svg.append(
      el("ellipse", {
        cx: String(w / 2),
        cy: String(h / 2),
        rx: String(w * 0.38),
        ry: String(h * 0.38),
        fill: innerCircleFill ?? "none",
        stroke,
        "stroke-width": "2",
      }),
    );
  }
  if (type === ShapeType.MermaidCherryPick) {
    for (const x of [0.35, 0.65]) {
      line(w * x, h * 0.6, w * 0.5, h * 0.25);
      svg.append(
        el("ellipse", {
          cx: String(w * x),
          cy: String(h * 0.65),
          rx: String(w * 0.1375),
          ry: String(h * 0.1375),
          fill: "none",
          stroke,
          "stroke-width": "2",
        }),
      );
    }
  }
  if (type === ShapeType.MermaidCrossCirc) {
    line(w * 0.3, h * 0.3, w * 0.7, h * 0.7);
    line(w * 0.7, h * 0.3, w * 0.3, h * 0.7);
  }
}

export function createMermaidSvgElement(
  model: ShapeElementModel,
  fillColor: string,
  strokeColor: string,
) {
  const type = model.shapeType as ShapeType;
  if (!isMermaidShapeType(type)) return null;
  const svg = el("svg", {
    width: "100%",
    height: "100%",
    viewBox: `0 0 ${model.w} ${model.h}`,
    preserveAspectRatio: "none",
  }) as SVGSVGElement;
  const common = {
    fill:
      model.filled &&
      type !== ShapeType.MermaidText &&
      type !== ShapeType.MermaidDatastore &&
      !String(type).includes("brace")
        ? fillColor
        : "transparent",
    stroke:
      model.strokeStyle === "none" || type === ShapeType.MermaidText
        ? "transparent"
        : strokeColor,
    "stroke-width": String(model.strokeWidth),
    ...(model.strokeStyle === "dash" ? { "stroke-dasharray": "12 12" } : {}),
  };

  if (type === ShapeType.MermaidPerson) {
    const { head, body } = mermaidPersonGeometry(model.w, model.h);
    svg.append(
      el("rect", {
        x: String(body.x),
        y: String(body.y),
        width: String(body.width),
        height: String(body.height),
        rx: String(body.radius),
        ...common,
      }),
      el("circle", {
        cx: String(head.cx),
        cy: String(head.cy),
        r: String(head.radius),
        ...common,
      }),
    );
  } else if (
    type === ShapeType.MermaidCherryPick ||
    type === ShapeType.MermaidCrossCirc ||
    type === ShapeType.MermaidDoubleCircle ||
    type === ShapeType.MermaidFCirc ||
    type === ShapeType.MermaidFrCirc ||
    type === ShapeType.MermaidSmCirc
  ) {
    svg.append(
      el("ellipse", {
        cx: String(model.w / 2),
        cy: String(model.h / 2),
        rx: String(model.w / 2 - model.strokeWidth / 2),
        ry: String(model.h / 2 - model.strokeWidth / 2),
        ...common,
      }),
    );
  } else if (
    type === ShapeType.MermaidCylinder ||
    type === ShapeType.MermaidLinCyl
  ) {
    const ry = Math.min(16, model.h * 0.16);
    svg.append(
      el("path", {
        d: `M 0 ${ry} A ${model.w / 2} ${ry} 0 0 1 ${model.w} ${ry} L ${model.w} ${model.h - ry} A ${model.w / 2} ${ry} 0 0 1 0 ${model.h - ry} Z`,
        ...common,
      }),
    );
  } else {
    const inset =
      type === ShapeType.MermaidBang ? Math.max(model.strokeWidth, 0) / 2 : 0;
    const d = pathFor(
      type,
      inset ? Math.max(0, model.w - inset * 2) : model.w,
      inset ? Math.max(0, model.h - inset * 2) : model.h,
    );
    svg.append(
      d
        ? el("path", {
            d,
            ...common,
            ...(type === ShapeType.MermaidBang
              ? {
                  transform: `translate(${inset} ${inset})`,
                  "stroke-linejoin": "round",
                }
              : {}),
          })
        : el("polygon", {
            points: pointString(
              type === ShapeType.MermaidBlockArrow &&
                model.mermaidContour.length >= 3
                ? mermaidContourPoints(model.mermaidContour, {
                    x: 0,
                    y: 0,
                    w: model.w,
                    h: model.h,
                  })
                : points(type, model.w, model.h),
            ),
            ...common,
          }),
    );
  }
  if (type === ShapeType.MermaidBraces) {
    svg.append(
      el("path", {
        d: pathFor(ShapeType.MermaidBraceR, model.w, model.h),
        fill: "none",
        stroke: strokeColor,
        "stroke-width": String(model.strokeWidth),
      }),
    );
  }
  appendDetails(
    svg,
    type,
    model.w,
    model.h,
    strokeColor,
    model.innerCircleFilled ? fillColor : undefined,
  );
  return svg;
}
