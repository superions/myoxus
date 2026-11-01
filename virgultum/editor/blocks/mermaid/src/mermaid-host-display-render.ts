import { html } from "lit";

import type { MermaidRenderState } from "./mermaid-block-constants.js";
import { shouldScheduleMermaidDisplayPreview } from "./mermaid-render-state.js";

export function renderMermaidDisplayBody({
  renderPreview,
  renderState,
  scheduleRender,
  source,
}: {
  readonly renderPreview: () => unknown;
  readonly renderState: MermaidRenderState;
  readonly scheduleRender: () => void;
  readonly source: string;
}) {
  if (shouldScheduleMermaidDisplayPreview({ renderState, source })) {
    scheduleRender();
  }
  return html`<div class="myoxus-mermaid-display-preview">
    ${renderPreview()}
  </div>`;
}
