import { createElement, type ReactNode } from "react";

import type { MermaidRenderState } from "./mermaid-block-constants.js";
import { shouldScheduleMermaidDisplayPreview } from "./mermaid-render-state.js";

export function renderMermaidDisplayBody({
  renderPreview,
  renderState,
  scheduleRender,
  source,
}: {
  readonly renderPreview: () => ReactNode;
  readonly renderState: MermaidRenderState;
  readonly scheduleRender: () => void;
  readonly source: string;
}) {
  if (shouldScheduleMermaidDisplayPreview({ renderState, source })) {
    scheduleRender();
  }
  return createElement(
    "div",
    { className: "myoxus-mermaid-display-preview" },
    renderPreview(),
  );
}
