import {
  DomElementRendererExtension,
  TextUtils,
  type DomRenderer,
} from "@virgultum/block-surface";
import { PointLocation, SVGPathBuilder } from "@virgultum/global/gfx";
import {
  type ConnectorElementModel,
  ConnectorMode,
  DefaultTheme,
  type LocalConnectorElementModel,
  type PointStyle,
} from "@virgultum/model";

import { isConnectorWithLabel } from "../connector-manager";
import { DEFAULT_ARROW_SIZE } from "./utils";
import { createRoundedPolylinePath } from "./polyline-path";

interface PathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function calculatePathBounds(path: PointLocation[]): PathBounds {
  if (path.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  let minX = path[0][0];
  let minY = path[0][1];
  let maxX = path[0][0];
  let maxY = path[0][1];

  for (const point of path) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }

  return { minX, minY, maxX, maxY };
}

function createConnectorPath(
  points: PointLocation[],
  mode: ConnectorMode,
  radius = 0,
): string {
  if (points.length < 2) return "";
  if (mode === ConnectorMode.Orthogonal && radius > 0)
    return createRoundedPolylinePath(points, radius);

  const pathBuilder = new SVGPathBuilder();
  pathBuilder.moveTo(points[0][0], points[0][1]);

  if (mode === ConnectorMode.Curve) {
    // Use bezier curves
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      pathBuilder.curveTo(
        prev.absOut[0],
        prev.absOut[1],
        curr.absIn[0],
        curr.absIn[1],
        curr[0],
        curr[1],
      );
    }
  } else {
    // Use straight lines
    for (let i = 1; i < points.length; i++) {
      pathBuilder.lineTo(points[i][0], points[i][1]);
    }
  }

  return pathBuilder.build();
}

/** The DOM connector and semantic controls share this exact endpoint geometry. */
export function createConnectorEndpointMarker(
  id: string,
  style: PointStyle,
  color: string,
  backgroundColor: string,
  strokeWidth: number,
  isStart: boolean = false,
  endpointScale = strokeWidth / 2,
): SVGMarkerElement {
  const marker = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "marker",
  );
  const isCompositeErEndpoint =
    style === "DoubleBar" ||
    style === "BarCrowFoot" ||
    style === "CircleBar" ||
    style === "CircleCrowFoot" ||
    style === "CrowFoot";
  const size =
    DEFAULT_ARROW_SIZE * (strokeWidth / 2) * (isCompositeErEndpoint ? 1.25 : 1);

  marker.id = id;
  marker.setAttribute("viewBox", "0 0 20 20");
  marker.setAttribute("refX", isStart ? "20" : "0");
  marker.setAttribute("refY", "10");
  marker.setAttribute("markerWidth", String(size));
  marker.setAttribute("markerHeight", String(size));
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "strokeWidth");

  if (isCompositeErEndpoint) {
    // Match the Canvas endpoint basis: markers extend from the entity into
    // the line, and scale once in world units, independently of line width.
    const unit = DEFAULT_ARROW_SIZE * endpointScale,
      pad = strokeWidth,
      extent = unit * 2.23,
      halfHeight = unit * 0.72;
    marker.setAttribute(
      "viewBox",
      `${isStart ? -pad : -extent - pad} ${-halfHeight - pad} ${extent + pad * 2} ${halfHeight * 2 + pad * 2}`,
    );
    marker.setAttribute("refX", "0");
    marker.setAttribute("refY", "0");
    marker.setAttribute("markerWidth", String(extent + pad * 2));
    marker.setAttribute("markerHeight", String(halfHeight * 2 + pad * 2));
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g"),
      direction = isStart ? 1 : -1;
    group.setAttribute("fill", "none");
    group.setAttribute("stroke", color);
    group.setAttribute("stroke-width", String(strokeWidth));
    group.setAttribute("stroke-linecap", "round");
    group.setAttribute("stroke-linejoin", "round");
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        `M ${direction * unit * x1} ${unit * y1} L ${direction * unit * x2} ${unit * y2}`,
      );
      group.append(path);
    };
    const bar = (offset: number, half = 0.42) =>
      line(offset, -half, offset, half);
    const circle = (offset: number) => {
      const node = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      node.setAttribute("cx", String(direction * unit * offset));
      node.setAttribute("cy", "0");
      node.setAttribute("r", String(unit * 0.28));
      node.setAttribute("fill", backgroundColor);
      group.append(node);
    };
    if (["CrowFoot", "BarCrowFoot", "CircleCrowFoot"].includes(style)) {
      for (const spread of [-0.72, 0, 0.72]) line(1.15, 0, 0.12, spread);
    }
    if (style === "DoubleBar") {
      bar(0.35, 0.45);
      bar(0.9, 0.45);
    } else if (style === "CircleBar") {
      circle(0.35);
      bar(0.9);
    } else if (style === "BarCrowFoot") bar(1.9);
    else if (style === "CircleCrowFoot") circle(1.95);
    marker.append(group);
    return marker;
  }

  switch (style) {
    case "Arrow":
    case "Triangle":
    case "HalfFilledTop":
    case "HalfFilledBottom":
    case "HalfOpenTop":
    case "HalfOpenBottom": {
      // Match the Canvas tangent basis and world-unit scale, including which
      // half lies above/below the forward line at either endpoint.
      const unit = DEFAULT_ARROW_SIZE * endpointScale,
        direction = isStart ? 1 : -1,
        angle = style === "Arrow" ? Math.PI / 4 : Math.PI / 6,
        x = direction * unit * Math.cos(angle),
        y = unit * Math.sin(angle),
        extent = unit + strokeWidth,
        half = style.startsWith("Half"),
        filled = style === "Triangle" || style.startsWith("HalfFilled"),
        wing = style.endsWith("Top") ? -y : y,
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      marker.setAttribute(
        "viewBox",
        `${-extent} ${-extent} ${extent * 2} ${extent * 2}`,
      );
      marker.setAttribute("refX", "0");
      marker.setAttribute("refY", "0");
      marker.setAttribute("markerWidth", String(extent * 2));
      marker.setAttribute("markerHeight", String(extent * 2));
      marker.setAttribute("markerUnits", "userSpaceOnUse");
      path.setAttribute(
        "d",
        half
          ? `M 0 0 L ${x} ${wing}${filled ? ` L ${x} 0 Z` : ""}`
          : `M ${x} ${-y} L 0 0 L ${x} ${y}${filled ? " Z" : ""}`,
      );
      path.setAttribute("fill", filled ? color : "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", String(strokeWidth));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      marker.append(path);
      break;
    }
    case "Circle": {
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      circle.setAttribute("cx", "10");
      circle.setAttribute("cy", "10");
      circle.setAttribute("r", "4");
      circle.setAttribute("fill", color);
      circle.setAttribute("stroke", color);
      marker.append(circle);
      break;
    }
    case "Cross": {
      const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        ),
        unit = DEFAULT_ARROW_SIZE * endpointScale,
        direction = isStart ? 1 : -1,
        center = direction * unit * 0.35,
        half = unit * 0.34,
        extent = unit + strokeWidth;
      marker.setAttribute(
        "viewBox",
        `${-extent} ${-extent} ${extent * 2} ${extent * 2}`,
      );
      marker.setAttribute("refX", "0");
      marker.setAttribute("refY", "0");
      marker.setAttribute("markerWidth", String(extent * 2));
      marker.setAttribute("markerHeight", String(extent * 2));
      marker.setAttribute("markerUnits", "userSpaceOnUse");
      path.setAttribute(
        "d",
        `M ${center - half} ${-half} L ${center + half} ${half} M ${center - half} ${half} L ${center + half} ${-half}`,
      );
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", String(strokeWidth));
      marker.append(path);
      break;
    }
    case "CircleCross": {
      const radius = 5 * endpointScale,
        center = (isStart ? 1 : -1) * radius,
        pad = strokeWidth;
      marker.setAttribute(
        "viewBox",
        `${isStart ? -pad : -radius * 2 - pad} ${-radius - pad} ${radius * 2 + pad * 2} ${radius * 2 + pad * 2}`,
      );
      marker.setAttribute("refX", "0");
      marker.setAttribute("refY", "0");
      marker.setAttribute("markerWidth", String(radius * 2 + pad * 2));
      marker.setAttribute("markerHeight", String(radius * 2 + pad * 2));
      marker.setAttribute("markerUnits", "userSpaceOnUse");
      const circle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        ),
        plus = document.createElementNS("http://www.w3.org/2000/svg", "path");
      circle.setAttribute("cx", String(center));
      circle.setAttribute("cy", "0");
      circle.setAttribute("r", String(radius));
      circle.setAttribute("fill", backgroundColor);
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", String(strokeWidth));
      plus.setAttribute(
        "d",
        `M ${center - radius} 0 L ${center + radius} 0 M ${center} ${-radius} L ${center} ${radius}`,
      );
      plus.setAttribute("fill", "none");
      plus.setAttribute("stroke", color);
      plus.setAttribute("stroke-width", String(strokeWidth));
      plus.setAttribute("stroke-linecap", "round");
      marker.append(circle, plus);
      break;
    }
    case "HollowCircle": {
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      circle.setAttribute("cx", "10");
      circle.setAttribute("cy", "10");
      circle.setAttribute("r", "4");
      circle.setAttribute("fill", backgroundColor);
      circle.setAttribute("stroke", color);
      marker.append(circle);
      break;
    }
    case "Diamond": {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", "M 10 6 L 14 10 L 10 14 L 6 10 Z");
      path.setAttribute("fill", color);
      path.setAttribute("stroke", color);
      marker.append(path);
      break;
    }
    case "HollowDiamond": {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", "M 10 6 L 14 10 L 10 14 L 6 10 Z");
      path.setAttribute("fill", backgroundColor);
      path.setAttribute("stroke", color);
      marker.append(path);
      break;
    }
    case "HollowTriangle": {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        isStart ? "M 20 7 L 12 10 L 20 13 Z" : "M 0 7 L 8 10 L 0 13 Z",
      );
      path.setAttribute("fill", backgroundColor);
      path.setAttribute("stroke", color);
      marker.append(path);
      break;
    }
  }

  return marker;
}

function renderConnectorLabel(
  model: ConnectorElementModel,
  container: HTMLElement,
  renderer: DomRenderer,
  zoom: number,
) {
  if (!isConnectorWithLabel(model) || !model.labelXYWH) {
    return;
  }

  const [lx, ly, lw, lh] = model.labelXYWH;
  const {
    labelStyle: {
      color,
      fontSize,
      fontWeight,
      fontStyle,
      fontFamily,
      textAlign,
    },
  } = model;

  // Create label element
  const labelElement = document.createElement("div");
  labelElement.style.position = "absolute";
  // labelXYWH is model-space; the container already carries the connector's
  // origin. Apply only the local offset, as the Canvas label transform does.
  labelElement.style.left = `${(lx - model.x) * zoom}px`;
  labelElement.style.top = `${(ly - model.y) * zoom}px`;
  labelElement.style.width = `${lw * zoom}px`;
  labelElement.style.height = `${lh * zoom}px`;
  labelElement.style.pointerEvents = "none";
  labelElement.style.overflow = "hidden";
  labelElement.style.display = "flex";
  labelElement.style.alignItems = "center";
  labelElement.style.justifyContent =
    textAlign === "center"
      ? "center"
      : textAlign === "right"
        ? "flex-end"
        : "flex-start";

  // Style the text
  labelElement.style.color = renderer.getColorValue(
    color,
    DefaultTheme.black,
    true,
  );
  labelElement.style.fontSize = `${fontSize * zoom}px`;
  labelElement.style.fontWeight = fontWeight;
  labelElement.style.fontStyle = fontStyle;
  labelElement.style.fontFamily = TextUtils.wrapFontFamily(fontFamily);
  labelElement.style.textAlign = textAlign;
  labelElement.style.lineHeight = "1.2";
  labelElement.style.whiteSpace = "pre-wrap";
  labelElement.style.wordWrap = "break-word";

  // Add text content
  if (model.text) {
    labelElement.textContent = model.text.toString();
  }

  container.append(labelElement);
}

/**
 * Renders a ConnectorElementModel to a given HTMLElement using DOM/SVG.
 * This function is intended to be registered via the DomElementRendererExtension.
 *
 * @param model - The connector element model containing rendering properties.
 * @param element - The HTMLElement to apply the connector's styles to.
 * @param renderer - The main DOMRenderer instance, providing access to viewport and color utilities.
 */
export const connectorBaseDomRenderer = (
  model: ConnectorElementModel | LocalConnectorElementModel,
  element: HTMLElement,
  renderer: DomRenderer,
): void => {
  const { zoom } = renderer.viewport;
  const {
    mode,
    path: points,
    strokeStyle,
    frontEndpointStyle,
    rearEndpointStyle,
    strokeWidth,
    stroke,
  } = model;

  // Clear previous content
  element.innerHTML = "";

  // Early return if no path points
  if (!points || points.length < 2) {
    return;
  }

  // Calculate bounds for the SVG viewBox
  const pathBounds = calculatePathBounds(points);
  const padding = Math.max(strokeWidth * 2, 20); // Add padding for arrows
  const svgWidth = (pathBounds.maxX - pathBounds.minX + padding * 2) * zoom;
  const svgHeight = (pathBounds.maxY - pathBounds.minY + padding * 2) * zoom;
  const offsetX = pathBounds.minX - padding;
  const offsetY = pathBounds.minY - padding;

  // Create SVG element
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.position = "absolute";
  svg.style.left = `${offsetX * zoom}px`;
  svg.style.top = `${offsetY * zoom}px`;
  svg.style.width = `${svgWidth}px`;
  svg.style.height = `${svgHeight}px`;
  svg.style.overflow = "visible";
  svg.style.pointerEvents = "none";
  svg.setAttribute("viewBox", `0 0 ${svgWidth / zoom} ${svgHeight / zoom}`);

  // Create defs for markers
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.append(defs);

  const strokeColor = renderer.getColorValue(
    stroke,
    DefaultTheme.connectorColor,
    true,
  );
  const backgroundColor = renderer.getColorValue(
    DefaultTheme.noteBackgrounColor,
    DefaultTheme.noteBackgrounColor,
    true,
  );

  // Create markers for endpoints
  let startMarkerId = "";
  let endMarkerId = "";

  if (frontEndpointStyle !== "None") {
    startMarkerId = `start-marker-${model.id}`;
    const startMarker = createConnectorEndpointMarker(
      startMarkerId,
      frontEndpointStyle,
      strokeColor,
      backgroundColor,
      strokeWidth,
      true,
      model.endpointScale ?? strokeWidth / 2,
    );
    defs.append(startMarker);
  }

  if (rearEndpointStyle !== "None") {
    endMarkerId = `end-marker-${model.id}`;
    const endMarker = createConnectorEndpointMarker(
      endMarkerId,
      rearEndpointStyle,
      strokeColor,
      backgroundColor,
      strokeWidth,
      false,
      model.endpointScale ?? strokeWidth / 2,
    );
    defs.append(endMarker);
  }

  // Create path element
  const pathElement = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );

  // Adjust points relative to the SVG coordinate system
  const adjustedPoints = points.map((point) => {
    const adjustedPoint = new PointLocation([
      point[0] - offsetX,
      point[1] - offsetY,
    ]);
    if (point.absIn) {
      adjustedPoint.in = [
        point.absIn[0] - offsetX - adjustedPoint[0],
        point.absIn[1] - offsetY - adjustedPoint[1],
      ];
    }
    if (point.absOut) {
      adjustedPoint.out = [
        point.absOut[0] - offsetX - adjustedPoint[0],
        point.absOut[1] - offsetY - adjustedPoint[1],
      ];
    }
    return adjustedPoint;
  });

  const pathData = createConnectorPath(
    adjustedPoints,
    mode,
    model.routingCornerRadius,
  );
  pathElement.setAttribute("d", pathData);
  pathElement.setAttribute("stroke", strokeColor);
  pathElement.setAttribute("stroke-width", String(strokeWidth));
  pathElement.setAttribute("fill", "none");
  pathElement.setAttribute("stroke-linecap", "round");
  pathElement.setAttribute("stroke-linejoin", "round");

  // Apply stroke style
  if (strokeStyle === "dash") {
    pathElement.setAttribute("stroke-dasharray", "12,12");
  }

  // Apply markers
  if (startMarkerId) {
    pathElement.setAttribute("marker-start", `url(#${startMarkerId})`);
  }
  if (endMarkerId) {
    pathElement.setAttribute("marker-end", `url(#${endMarkerId})`);
  }

  let endpointPath: SVGPathElement | null = null;
  if ("labelXYWH" in model && isConnectorWithLabel(model) && model.labelXYWH) {
    const [lx, ly, lw, lh] = model.labelXYWH;
    // Match the Canvas cutout around the model-space label without painting a
    // rectangular background over other objects or the viewport's grid.
    const gap = 3.5;
    const x = lx - model.x - offsetX - gap;
    const y = ly - model.y - offsetY - gap;
    const width = lw + gap * 2;
    const height = lh + gap * 2;
    const clip = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "clipPath",
    );
    const cutout = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    clip.id = `label-clip-${model.id}`;
    cutout.setAttribute("clip-rule", "evenodd");
    cutout.setAttribute(
      "d",
      `M 0 0 H ${svgWidth / zoom} V ${svgHeight / zoom} H 0 Z M ${x} ${y} h ${width} v ${height} h ${-width} Z`,
    );
    clip.append(cutout);
    defs.append(clip);
    // Keep endpoint notation outside the shaft's label-clearance clip, matching
    // Canvas. The carrier has no shaft stroke; its markers own their strokes.
    endpointPath = pathElement.cloneNode() as SVGPathElement;
    endpointPath.setAttribute("stroke", "none");
    pathElement.removeAttribute("marker-start");
    pathElement.removeAttribute("marker-end");
    pathElement.setAttribute("clip-path", `url(#${clip.id})`);
  }

  svg.append(pathElement);
  if (endpointPath) svg.append(endpointPath);
  for (const [enabled, anchor] of [
    [model.frontEndpointCircle, adjustedPoints[0]],
    [model.rearEndpointCircle, adjustedPoints.at(-1)],
  ] as const) {
    if (!enabled || !anchor) continue;
    const circle = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    circle.setAttribute("cx", String(anchor[0]));
    circle.setAttribute("cy", String(anchor[1]));
    circle.setAttribute(
      "r",
      String(5 * (model.endpointScale ?? strokeWidth / 2)),
    );
    circle.setAttribute("fill", strokeColor);
    svg.append(circle);
  }
  element.append(svg);

  // Set element size and position
  element.style.width = `${model.w * zoom}px`;
  element.style.height = `${model.h * zoom}px`;
  element.style.overflow = "visible";
  element.style.pointerEvents = "none";
};

export const connectorDomRenderer = (
  model: ConnectorElementModel,
  element: HTMLElement,
  renderer: DomRenderer,
): void => {
  connectorBaseDomRenderer(model, element, renderer);
  renderConnectorLabel(model, element, renderer, renderer.viewport.zoom);
};

/**
 * Extension to register the DOM-based renderer for 'connector' elements.
 */
export const ConnectorDomRendererExtension = DomElementRendererExtension(
  "connector",
  connectorDomRenderer,
);
