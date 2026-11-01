// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ConnectorMode,
  LineWidth,
  PointStyle,
  ShapeType,
  StrokeStyle,
} from "@virgultum/model";

import type {
  MermaidGfxConnectorElementProjection,
  MermaidGfxNodeElementProjection,
} from "./gfx-family-hooks-contract.js";
import type {
  MermaidVisualEdge,
  MermaidVisualEndpointMarker,
  MermaidVisualNode,
} from "./gfx-model.js";

export const MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE: Record<
  MermaidVisualNode["shape"],
  ShapeType
> = {
  asymmetric: ShapeType.MermaidAsymmetric,
  bang: ShapeType.MermaidBang,
  bolt: ShapeType.MermaidBolt,
  "bow-rect": ShapeType.MermaidBowRect,
  brace: ShapeType.MermaidBrace,
  "brace-r": ShapeType.MermaidBraceR,
  braces: ShapeType.MermaidBraces,
  "cherry-pick": ShapeType.MermaidCherryPick,
  circle: ShapeType.Ellipse,
  cloud: ShapeType.MermaidCloud,
  "cross-circ": ShapeType.MermaidCrossCirc,
  "curv-trap": ShapeType.MermaidCurvTrap,
  database: ShapeType.MermaidCylinder,
  datastore: ShapeType.MermaidDatastore,
  delay: ShapeType.MermaidDelay,
  diam: ShapeType.Diamond,
  diamond: ShapeType.Diamond,
  "div-rect": ShapeType.MermaidDivRect,
  doc: ShapeType.MermaidDoc,
  docs: ShapeType.MermaidDocs,
  doublecircle: ShapeType.MermaidDoubleCircle,
  "f-circ": ShapeType.MermaidFCirc,
  flag: ShapeType.MermaidFlag,
  "flip-tri": ShapeType.MermaidFlipTri,
  fork: ShapeType.MermaidFork,
  "fr-circ": ShapeType.MermaidFrCirc,
  "fr-rect": ShapeType.MermaidFrRect,
  "h-cyl": ShapeType.MermaidHCyl,
  hexagon: ShapeType.MermaidHexagon,
  hourglass: ShapeType.MermaidHourglass,
  "lean-l": ShapeType.MermaidLeanL,
  "lean-r": ShapeType.MermaidLeanR,
  "lin-cyl": ShapeType.MermaidLinCyl,
  "lin-doc": ShapeType.MermaidLinDoc,
  "lin-rect": ShapeType.MermaidLinRect,
  "notch-pent": ShapeType.MermaidNotchPent,
  "notch-rect": ShapeType.MermaidNotchRect,
  odd: ShapeType.MermaidOdd,
  person: ShapeType.MermaidPerson,
  parallelogram: ShapeType.MermaidLeanR,
  rect: ShapeType.Rect,
  rounded: ShapeType.Rect,
  "sl-rect": ShapeType.MermaidSlRect,
  "sm-circ": ShapeType.MermaidSmCirc,
  stadium: ShapeType.MermaidStadium,
  "st-rect": ShapeType.MermaidStRect,
  subroutine: ShapeType.MermaidSubroutine,
  "tag-doc": ShapeType.MermaidTagDoc,
  "tag-rect": ShapeType.MermaidTagRect,
  text: ShapeType.MermaidText,
  "trap-b": ShapeType.MermaidTrapB,
  "trap-t": ShapeType.MermaidTrapT,
  trapezoid: ShapeType.MermaidTrapB,
  tri: ShapeType.Triangle,
  "win-pane": ShapeType.MermaidWinPane,
};

export function endpointPointStyle(marker: MermaidVisualEndpointMarker) {
  if (marker === "arrow") return PointStyle.Arrow;
  if (marker === "double-bar") return PointStyle.DoubleBar;
  if (marker === "bar") return PointStyle.Bar;
  if (marker === "bar-crow-foot") return PointStyle.BarCrowFoot;
  if (marker === "circle") return PointStyle.Circle;
  if (marker === "circle-bar") return PointStyle.CircleBar;
  if (marker === "circle-crow-foot") return PointStyle.CircleCrowFoot;
  if (marker === "cross") return PointStyle.Cross;
  if (marker === "crow-foot") return PointStyle.CrowFoot;
  if (marker === "diamond") return PointStyle.Diamond;
  if (marker === "hollow-circle") return PointStyle.HollowCircle;
  if (marker === "circle-cross") return PointStyle.CircleCross;
  if (marker === "hollow-diamond") return PointStyle.HollowDiamond;
  if (marker === "hollow-triangle") return PointStyle.HollowTriangle;
  if (marker === "triangle") return PointStyle.Triangle;
  if (marker === "half-filled-top") return PointStyle.HalfFilledTop;
  if (marker === "half-filled-bottom") return PointStyle.HalfFilledBottom;
  if (marker === "half-open-top") return PointStyle.HalfOpenTop;
  if (marker === "half-open-bottom") return PointStyle.HalfOpenBottom;
  return PointStyle.None;
}

export function projectNeutralMermaidGfxNodeElement(
  node: MermaidVisualNode,
): MermaidGfxNodeElementProjection {
  return {
    radius:
      node.shape === "rounded" ||
      node.shape === "stadium" ||
      node.shape === "delay"
        ? 0.16
        : 0,
    shapeType: MERMAID_VISUAL_SHAPE_TO_GFX_SHAPE[node.shape] ?? ShapeType.Rect,
  };
}

export function projectNeutralMermaidGfxSubgraphElement(): MermaidGfxNodeElementProjection {
  return { radius: 0.08, shapeType: ShapeType.Rect };
}

export function projectNeutralMermaidGfxConnectorElement(
  edge: MermaidVisualEdge,
): MermaidGfxConnectorElementProjection {
  return {
    frontEndpointStyle: edge.sourceMarker
      ? endpointPointStyle(edge.sourceMarker)
      : edge.linkType === "bidirectional" || edge.linkType === "reverse"
        ? PointStyle.Arrow
        : PointStyle.None,
    mode:
      edge.connectorMode === "curve"
        ? ConnectorMode.Curve
        : edge.connectorMode === "straight"
          ? ConnectorMode.Straight
          : ConnectorMode.Orthogonal,
    rearEndpointStyle: edge.targetMarker
      ? endpointPointStyle(edge.targetMarker)
      : edge.linkType === "open" || edge.linkType === "reverse"
        ? PointStyle.None
        : edge.linkType === "circle"
          ? PointStyle.Circle
          : edge.linkType === "cross"
            ? PointStyle.Diamond
            : PointStyle.Arrow,
    strokeStyle: edge.style === "dotted" ? StrokeStyle.Dash : StrokeStyle.Solid,
    strokeWidth: edge.style === "thick" ? LineWidth.Four : LineWidth.Two,
  };
}
