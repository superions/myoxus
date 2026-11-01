// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Family-neutral GFX contract consumed by the block host. Concrete families
 * select capabilities in their adapters; this module only exposes the shared
 * owner model, interaction session and renderer primitives.
 */
export type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
  MermaidVisualSubgraph,
} from "./gfx-model.js";
export { detectMermaidDiagramType } from "../../engine/diagram-types.js";
export { parseMermaidSourceToGfxVisualModel } from "../../mermaid-gfx-graph-adapters.js";
export { resolveMermaidGfxEdgeEndpointPositions } from "./gfx-model.js";
export { MermaidGfxSessionController } from "./gfx-session.js";
export { resolveMermaidGfxEditorState } from "./gfx-editor-state.js";
export { resolveMermaidGfxContextMenuLabel } from "./gfx-interaction.js";
export { isMermaidFamilyVisualEditingDiagramType } from "../registry.js";
export { renderMermaidGfxPageEditor } from "../visual-gfx-editor.js";
export {
  clampMermaidVisualViewportHeight,
  resolveMermaidVisualViewportHeight,
} from "../../mermaid-gfx-viewport.js";
