import { DomElementRendererExtension } from "@virgultum/canvas-runtime/surface";

import { shapeDomRenderer } from "./shape-dom/index.js";

/**
 * Extension to register the DOM-based renderer for 'shape' elements.
 */
export const ShapeDomRendererExtension = DomElementRendererExtension(
  "shape",
  shapeDomRenderer,
);
