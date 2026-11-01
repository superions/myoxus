// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  shapeMethods,
  mermaidSoftShapePath,
  ShapeType,
} from "@virgultum/model";
import { Bound } from "@virgultum/global/gfx";
import {
  mermaidMessages as m,
  type MermaidMindmapShape,
} from "@virgultum/block-mermaid";

export function mindmapShapeLabel(shape: MermaidMindmapShape) {
  switch (shape) {
    case "default":
      return m.optionDefault();
    case "square":
      return m.shapeSquare();
    case "rounded":
      return m.shapeRounded();
    case "circle":
      return m.shapeCircle();
    case "cloud":
      return m.shapeCloud();
    case "bang":
      return m.shapeBang();
    case "hexagon":
      return m.shapeHexagon();
  }
}

/** Technical icon viewport; Cloud/Bang/Hexagon use the same native contours as
 * the canvas. This is a passive select adornment, not an editable renderer. */
export function MindmapShapePreview({ shape }: { shape: MermaidMindmapShape }) {
  const soft =
    shape === "cloud" || shape === "bang"
      ? mermaidSoftShapePath(
          shape === "cloud" ? ShapeType.MermaidCloud : ShapeType.MermaidBang,
          32,
          24,
        )
      : null;
  return (
    <svg
      width="1.5em"
      height="1.5em"
      viewBox="0 0 36 28"
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="var(--myoxus-icon-stroke-width)"
        strokeLinejoin={shape === "bang" ? "round" : undefined}
      >
        {soft ? (
          <path d={soft} transform="translate(2 2)" />
        ) : shape === "circle" ? (
          <circle cx="18" cy="14" r="11" />
        ) : shape === "hexagon" ? (
          <polygon
            points={shapeMethods[ShapeType.MermaidHexagon]
              .points(new Bound(2, 2, 32, 24))
              .map((point) => point.join(","))
              .join(" ")}
          />
        ) : (
          <rect
            x="2"
            y="2"
            width="32"
            height="24"
            rx={shape === "square" ? 0 : 4}
          />
        )}
      </g>
    </svg>
  );
}
