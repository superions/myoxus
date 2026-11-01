import type { MermaidDisplayMode } from "./mermaid-block-constants.js";

export const MERMAID_RENDER_DEBOUNCE_MS = 120;

export type MermaidStaticRenderDecision = "empty" | "render" | "skip-gfx-edit";

export function resolveMermaidStaticRenderDecision(input: {
  displayMode: MermaidDisplayMode;
  isGfxDiagramType: boolean;
  source: string;
}): MermaidStaticRenderDecision {
  const { isGfxDiagramType, source } = input;
  if (!source.trim()) return "empty";
  if (isGfxDiagramType) return "skip-gfx-edit";
  return "render";
}

export function shouldScheduleMermaidDisplayPreview({
  renderState,
  source,
}: {
  renderState: string;
  source: string;
}) {
  return Boolean(source.trim()) && renderState === "empty";
}
