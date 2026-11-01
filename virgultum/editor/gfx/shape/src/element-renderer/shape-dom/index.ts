import { TextUtils, type DomRenderer } from "@virgultum/block-surface";
import { isRTL } from "@virgultum/gfx-text";
import { SVGShapeBuilder } from "@virgultum/global/gfx";
import {
  DefaultTheme,
  getMermaidSubgraphCollapseBound,
  getMermaidSubgraphCollapsePoints,
  isMermaidShapeType,
  type ShapeElementModel,
} from "@virgultum/model";

import { createMermaidSvgElement } from "./mermaid-svg.js";
import { projectedShapeLabelSvg } from "../label-projection.js";
import { manageClassNames, setStyles } from "./utils";

function applyShapeSpecificStyles(
  model: ShapeElementModel,
  element: HTMLElement,
  zoom: number,
) {
  // Reset properties that might be set by different shape types
  element.style.removeProperty("clip-path");
  element.style.removeProperty("border-radius");
  // Clear DOM for shapes that don't use SVG, or if type changes from SVG-based to non-SVG-based
  if (
    model.shapeType !== "diamond" &&
    model.shapeType !== "triangle" &&
    !isMermaidShapeType(model.shapeType)
  ) {
    while (element.firstChild) element.firstChild.remove();
  }

  switch (model.shapeType) {
    case "rect": {
      const w = model.w * zoom;
      const h = model.h * zoom;
      const r = model.radius ?? 0;
      const borderRadius =
        r < 1 ? `${Math.min(w * r, h * r)}px` : `${r * zoom}px`;
      element.style.borderRadius = borderRadius;
      break;
    }
    case "ellipse":
      element.style.borderRadius = "50%";
      break;
    case "diamond":
      element.style.clipPath = "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)";
      break;
    case "triangle":
      element.style.clipPath = "polygon(50% 0%, 100% 100%, 0% 100%)";
      break;
  }
  // No 'else' needed to clear styles, as they are reset at the beginning of the function.
}

function applyBorderStyles(
  model: ShapeElementModel,
  element: HTMLElement,
  strokeColor: string,
  zoom: number,
) {
  element.style.border =
    model.strokeStyle !== "none"
      ? `${model.strokeWidth * zoom}px ${model.strokeStyle === "dash" ? "dashed" : "solid"} ${strokeColor}`
      : "none";
}

function applyTransformStyles(model: ShapeElementModel, element: HTMLElement) {
  if (model.rotate && model.rotate !== 0) {
    setStyles(element, {
      transform: `rotate(${model.rotate}deg)`,
      transformOrigin: "center",
    });
  } else {
    setStyles(element, {
      transform: "",
      transformOrigin: "",
    });
  }
}

function applyShadowStyles(
  model: ShapeElementModel,
  element: HTMLElement,
  renderer: DomRenderer,
) {
  if (model.shadow) {
    const { offsetX, offsetY, blur, color } = model.shadow;
    setStyles(element, {
      boxShadow: `${offsetX}px ${offsetY}px ${blur}px ${renderer.getColorValue(color)}`,
    });
  } else {
    setStyles(element, { boxShadow: "" });
  }
}

/**
 * Renders a ShapeElementModel to a given HTMLElement using DOM properties.
 * This function is intended to be registered via the DomElementRendererExtension.
 *
 * @param model - The shape element model containing rendering properties.
 * @param element - The HTMLElement to apply the shape's styles to.
 * @param renderer - The main DOMRenderer instance, providing access to viewport and color utilities.
 */
export const shapeDomRenderer = (
  model: ShapeElementModel,
  element: HTMLElement,
  renderer: DomRenderer,
): void => {
  const { zoom } = renderer.viewport;
  const unscaledWidth = model.w;
  const unscaledHeight = model.h;

  const newChildren: Element[] = [];

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

  element.style.width = `${unscaledWidth * zoom}px`;
  element.style.height = `${unscaledHeight * zoom}px`;
  element.style.boxSizing = "border-box";

  // Apply shape-specific clipping, border-radius, and potentially clear innerHTML
  applyShapeSpecificStyles(model, element, zoom);

  if (isMermaidShapeType(model.shapeType)) {
    element.style.border = "none";
    element.style.backgroundColor = "transparent";
    const svg = createMermaidSvgElement(model, fillColor, strokeColor);
    if (svg) newChildren.push(svg);
  } else if (model.shapeType === "diamond" || model.shapeType === "triangle") {
    // For diamond and triangle, fill and border are handled by inline SVG
    element.style.border = "none"; // Ensure no standard CSS border interferes
    element.style.backgroundColor = "transparent"; // Host element is transparent

    const strokeW = model.strokeWidth;

    let svgPoints = "";
    if (model.shapeType === "diamond") {
      // Generate diamond points using shared utility
      svgPoints = SVGShapeBuilder.diamond(
        unscaledWidth,
        unscaledHeight,
        strokeW,
      );
    } else {
      // triangle - generate triangle points using shared utility
      svgPoints = SVGShapeBuilder.triangle(
        unscaledWidth,
        unscaledHeight,
        strokeW,
      );
    }

    // Determine if stroke should be visible and its color
    const finalStrokeColor =
      model.strokeStyle !== "none" && strokeW > 0 ? strokeColor : "transparent";
    // Determine dash array, only if stroke is visible and style is 'dash'
    const finalStrokeDasharray =
      model.strokeStyle === "dash" && finalStrokeColor !== "transparent"
        ? "12, 12"
        : "none";
    // Determine fill color
    const finalFillColor = model.filled ? fillColor : "transparent";

    // Build SVG safely with DOM-API
    const SVG_NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("viewBox", `0 0 ${unscaledWidth} ${unscaledHeight}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", svgPoints);
    polygon.setAttribute("fill", finalFillColor);
    polygon.setAttribute("stroke", finalStrokeColor);
    polygon.setAttribute("stroke-width", String(strokeW));
    if (finalStrokeDasharray !== "none") {
      polygon.setAttribute("stroke-dasharray", finalStrokeDasharray);
    }
    svg.append(polygon);

    newChildren.push(svg);
  } else {
    // Standard rendering for other shapes (e.g., rect, ellipse)
    // innerHTML was already cleared by applyShapeSpecificStyles if necessary
    element.style.backgroundColor = model.filled ? fillColor : "transparent";
    applyBorderStyles(model, element, strokeColor, zoom); // Uses standard CSS border
  }

  if (model.textDisplay && model.labelProjection) {
    newChildren.push(
      projectedShapeLabelSvg(
        model,
        renderer.getColorValue(model.color, DefaultTheme.shapeTextColor, true),
      ),
    );
  } else if (model.textDisplay && model.text) {
    const str = model.text.toString();
    const [verticalPadding, horizontalPadding] = model.padding;
    const textElement = document.createElement("div");
    if (isRTL(str)) {
      textElement.dir = "rtl";
    }
    textElement.style.position = "absolute";
    textElement.style.inset = "0";
    textElement.style.boxSizing = "border-box";
    textElement.style.display = "flex";
    textElement.style.flexDirection = "column";
    textElement.style.justifyContent =
      model.textVerticalAlign === "center"
        ? "center"
        : model.textVerticalAlign === "top"
          ? "flex-start"
          : "flex-end";
    textElement.style.whiteSpace = "pre-wrap";
    textElement.style.wordBreak = "break-word";
    textElement.style.textAlign = model.textAlign;
    textElement.style.alignmentBaseline = "alphabetic";
    textElement.style.fontFamily = TextUtils.wrapFontFamily(model.fontFamily);
    textElement.style.textDecoration = model.textDecoration;
    textElement.style.fontSize = `${model.fontSize * zoom}px`;
    textElement.style.fontStyle = model.fontStyle;
    textElement.style.fontWeight = model.fontWeight;
    textElement.style.lineHeight = "normal";
    textElement.style.padding = `${verticalPadding * zoom}px ${horizontalPadding * zoom}px`;
    textElement.style.color = renderer.getColorValue(
      model.color,
      DefaultTheme.shapeTextColor,
      true,
    );
    textElement.textContent = str;
    newChildren.push(textElement);
  }

  const chrome = getMermaidSubgraphCollapseBound(model);
  if (chrome) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${chrome.w} ${chrome.h}`);
    svg.setAttribute("aria-hidden", "true");
    const borderInset = Number.parseFloat(element.style.borderWidth) || 0;
    Object.assign(svg.style, {
      position: "absolute",
      left: `${(chrome.x - model.x) * zoom - borderInset}px`,
      top: `${(chrome.y - model.y) * zoom - borderInset}px`,
      width: `${chrome.w * zoom}px`,
      height: `${chrome.h * zoom}px`,
      pointerEvents: "none",
    });
    const path = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    path.setAttribute(
      "points",
      getMermaidSubgraphCollapsePoints(model)
        .map(([x, y]) => `${x - chrome.x},${y - chrome.y}`)
        .join(" "),
    );
    path.setAttribute("fill", "none");
    path.setAttribute(
      "stroke",
      renderer.getColorValue(model.color, DefaultTheme.shapeTextColor, true),
    );
    path.setAttribute("stroke-width", String(Math.max(model.strokeWidth, 1)));
    svg.append(path);
    newChildren.push(svg);
  }

  // Replace existing children to avoid memory leaks
  element.replaceChildren(...newChildren);

  applyTransformStyles(model, element);

  manageClassNames(model, element);
  applyShadowStyles(model, element, renderer);
};
