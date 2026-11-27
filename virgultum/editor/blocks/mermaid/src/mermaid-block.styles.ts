// SPDX-License-Identifier: AGPL-3.0-or-later

import { cssVar } from "@myoxus/theme";

// Scoped diagram geometry and the display projection's semantic theme roles.
const mermaidBlockStyles = `
  myoxus-mermaid {
    position: relative;
    display: block;
  }

  /* Native document block flow owns these siblings; a React Stack cannot wrap
     persisted editor blocks. Embedded Notes retain their canvas geometry. */
  myoxus-page-root myoxus-mermaid + myoxus-mermaid {
    margin-block-start: var(--mantine-spacing-md);
  }

  [data-mermaid-edgeless-embedded="true"] {
    /* Edgeless Notes project their own readable surface roles. React chart
       facades otherwise retain the application-level Mantine colour mode and
       can render dark labels on a light Note (or the inverse). Bridge only
       this embedded consumer back to the Note-owned semantic roles. */
    --mantine-color-body: var(--myoxus-background-primary-color);
    --mantine-color-dimmed: var(--myoxus-text-secondary-color);
    --mantine-color-text: var(--myoxus-text-primary-color);
  }

  .myoxus-mermaid-last-valid-preview {
    display: grid;
    width: 100%;
    min-width: 0;
    place-items: center;
  }

  .myoxus-mermaid-last-valid-preview > div {
    display: grid;
    width: 100%;
    min-width: 0;
    place-items: center;
  }

  .myoxus-mermaid-display-preview {
    display: grid;
    overflow: hidden;
    border: 1px solid ${cssVar("borderColor")};
    border-radius: var(--mantine-radius-md);
    background: ${cssVar("backgroundPrimaryColor")};
    min-height: calc(var(--myoxus-typography-body-line-height) * 9);
    padding: var(--mantine-spacing-md);
    place-items: center;
  }

  .myoxus-mermaid-display-preview > div {
    display: grid;
    width: 100%;
    min-width: 0;
    place-items: center;
  }

  .myoxus-mermaid-display-preview svg {
    display: block;
    width: auto !important;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }

  .myoxus-mermaid-file-input {
    display: none;
  }

  .myoxus-mermaid-gfx-editor {
    display: grid;
    min-height: var(
      --myoxus-mermaid-gfx-viewport-height,
      calc(var(--myoxus-typography-body-line-height) * 18)
    );
    grid-template-rows: auto minmax(0, 1fr);
    border-top: 1px solid ${cssVar("borderColor")};
    background: ${cssVar("backgroundPrimaryColor")};
  }

  .myoxus-mermaid-gfx-editor[data-mermaid-display-mode="display"] {
    border-top: 0;
    background: transparent;
  }

  [data-mermaid-edgeless-embedded="true"]
    .myoxus-mermaid-gfx-editor[data-mermaid-gfx-surface="true"]
    > .myoxus-mermaid-gfx-viewport,
  .myoxus-mermaid-gfx-editor > .myoxus-mermaid-gfx-viewport {
    --myoxus-mermaid-canvas-background: ${cssVar("noteBackgroundWhite")};
    --myoxus-background-primary-color: var(--myoxus-mermaid-canvas-background);
    --myoxus-text-primary-color: ${cssVar("textPrimaryColor")};

    position: relative;
    height: var(
      --myoxus-mermaid-gfx-viewport-height,
      calc(var(--myoxus-typography-body-line-height) * 18)
    );
    min-height: var(
      --myoxus-mermaid-gfx-viewport-height,
      calc(var(--myoxus-typography-body-line-height) * 18)
    );
    overflow: hidden;
    background-color: var(--myoxus-mermaid-canvas-background);
    background-image: radial-gradient(
      var(--myoxus-edgeless-grid-color) 1px,
      transparent 1px
    );
    background-size: 20px 20px;
    container-name: viewport;
    container-type: inline-size;
  }

  .myoxus-mermaid-gfx-editor > .myoxus-mermaid-gfx-viewport:focus:not(:focus-visible) {
    outline: none;
  }

  .myoxus-mermaid-gfx-editor[data-mermaid-display-mode="display"]
    > .myoxus-mermaid-gfx-viewport {
    --myoxus-background-primary-color: transparent;
    --myoxus-edgeless-grid-color: transparent;
    --myoxus-mermaid-canvas-background: transparent;

    background-color: transparent;
    background-image: none;
  }

  .myoxus-mermaid-viewport-resize-row {
    display: flex;
    height: var(--mantine-spacing-md);
    align-items: center;
    justify-content: center;
    border-top: 1px solid ${cssVar("borderColor")};
    background: ${cssVar("backgroundSecondaryColor")};
  }

  .myoxus-mermaid-viewport-resize-handle {
    position: relative;
    width: calc(var(--mantine-spacing-2xl) * 3);
    height: var(--mantine-spacing-xs);
    border: 0;
    border-radius: var(--mantine-radius-xl);
    background: transparent;
    cursor: ns-resize;
    padding: 0;
  }

  .myoxus-mermaid-viewport-resize-handle::before {
    position: absolute;
    top: var(--mantine-spacing-2xs);
    left: var(--mantine-spacing-md);
    right: var(--mantine-spacing-md);
    height: 2px;
    border-radius: var(--mantine-radius-xl);
    background: ${cssVar("borderColor")};
    content: "";
  }

  .myoxus-mermaid-viewport-resize-handle:hover::before,
  .myoxus-mermaid-viewport-resize-handle:focus-visible::before {
    background: ${cssVar("primaryColor")};
  }

  .myoxus-mermaid-viewport-resize-handle:focus-visible {
    outline: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    outline-offset: 2px;
  }

  .myoxus-mermaid-gfx-viewport .myoxus-mermaid-inline-mount-point {
    position: absolute;
    inset: 0;
    z-index: 4;
    pointer-events: auto;
  }

  .myoxus-mermaid-gfx-viewport .myoxus-mermaid-inline-mount-point:empty {
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-viewport
    .myoxus-mermaid-inline-mount-point
    edgeless-shape-text-editor {
    pointer-events: auto;
  }

  .myoxus-mermaid-gfx-viewport .myoxus-mermaid-inline-node-editor {
    position: absolute;
    z-index: 20;
    box-sizing: border-box;
    border: calc(var(--mantine-scale) * 1px) solid
      ${cssVar("primaryColor")};
    border-radius: var(--mantine-radius-sm);
    background: ${cssVar("backgroundPrimaryColor")};
    color: ${cssVar("textPrimaryColor")};
    text-align: center;
    outline: none;
    pointer-events: auto;
  }

  .myoxus-mermaid-gfx-viewport .myoxus-mermaid-inline-node-editor:focus {
    outline: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    outline-offset: calc(var(--mantine-scale) * 1px);
  }

  .myoxus-mermaid-gfx-object-focus-proxy,
  .myoxus-mermaid-gfx-selection-live-region {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    pointer-events: none;
    white-space: nowrap;
  }

  .myoxus-mermaid-gfx-keyboard-focus-outline {
    position: absolute;
    z-index: 17;
    border: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    border-radius: var(--mantine-radius-sm);
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-selection-chrome,
  .myoxus-mermaid-gfx-selection-outline,
  .myoxus-mermaid-gfx-selection-bounds {
    position: absolute;
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-selection-chrome {
    inset: 0;
    z-index: 16;
  }

  .myoxus-mermaid-gfx-selection-outline {
    box-sizing: border-box;
    border: calc(var(--mantine-scale) * 2px) solid
      ${cssVar("primaryColor")};
    border-radius: var(--mantine-radius-sm);
  }

  .myoxus-mermaid-gfx-selection-bounds {
    box-sizing: border-box;
    border: calc(var(--mantine-scale) * 1px) dashed
      ${cssVar("primaryColor")};
    border-radius: var(--mantine-radius-sm);
  }

  .myoxus-mermaid-gfx-selection-bounds > span {
    position: absolute;
    inset-inline-start: 0;
    inset-block-start: 0;
    padding: var(--mantine-spacing-xs);
    border-radius: var(--mantine-radius-sm);
    background: ${cssVar("backgroundPrimaryColor")};
    color: ${cssVar("textPrimaryColor")};
    font: inherit;
    font-size: var(--mantine-font-size-xs);
  }

  .myoxus-mermaid-gfx-editor[data-inserting-shape="true"]
    .myoxus-mermaid-gfx-viewport {
    cursor: crosshair;
  }

  .myoxus-mermaid-gfx-connection-preview {
    position: absolute;
    inset: 0;
    z-index: 18;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-alignment-guides {
    position: absolute;
    inset: 0;
    z-index: 17;
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-snap-guides {
    position: absolute;
    inset: 0;
    z-index: 19;
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-snap-guide {
    position: absolute;
    background: var(--myoxus-primary-color);
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-snap-guide[data-snap-guide-kind="spacing"] {
    background: transparent;
    border-top: 1px dashed var(--myoxus-primary-color);
  }

  .myoxus-mermaid-gfx-snap-guide[data-snap-guide-kind="spacing"][data-snap-guide-axis="x"] {
    border-top: 0;
    border-left: 1px dashed var(--myoxus-primary-color);
  }

  .myoxus-mermaid-gfx-snap-gap {
    position: absolute;
    padding: 1px 5px;
    border-radius: var(--mantine-radius-xs);
    background: var(--myoxus-primary-color);
    color: var(--myoxus-background-primary-color);
    font-size: 10px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-drag-hud {
    position: absolute;
    z-index: 21;
    padding: 2px 6px;
    border: 1px solid ${cssVar("borderColor")};
    border-radius: var(--mantine-radius-xs);
    background: ${cssVar("backgroundPrimaryColor")};
    color: ${cssVar("textSecondaryColor")};
    box-shadow: var(--mantine-shadow-xs);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 1.3;
    white-space: nowrap;
    transform: translate(10px, 10px);
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-hover-connect-handle {
    position: absolute;
    z-index: 19;
    width: calc(var(--mantine-spacing-sm) + 4px);
    height: calc(var(--mantine-spacing-sm) + 4px);
    padding: 0;
    border: calc(var(--mantine-scale) * 1.5px) solid var(--myoxus-primary-color);
    border-radius: var(--mantine-radius-xl);
    background: ${cssVar("backgroundPrimaryColor")};
    box-shadow: var(--mantine-shadow-xs);
    cursor: crosshair;
    opacity: 0.78;
    transform: translate(-50%, -50%);
    transition: opacity 120ms ease, transform 120ms ease, background-color 120ms ease;
    touch-action: none;
  }

  .myoxus-mermaid-gfx-hover-connect-handle:hover {
    opacity: 1;
    background: var(--myoxus-primary-color);
    transform: translate(-50%, -50%) scale(1.15);
  }

  .myoxus-mermaid-gfx-alignment-guide {
    position: absolute;
    color: ${cssVar("warningColor")};
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-alignment-guide[data-alignment-direction="row"] {
    transform: translateY(var(--mantine-spacing-xs));
  }

  .myoxus-mermaid-gfx-alignment-guide[data-alignment-direction="column"] {
    transform: translateX(var(--mantine-spacing-xs));
  }

  .myoxus-mermaid-gfx-alignment-guide::before {
    position: absolute;
    inset: 50% 0 auto;
    border-block-start: calc(var(--mantine-scale) * 1px) dashed currentColor;
    content: "";
  }

  .myoxus-mermaid-gfx-alignment-guide[data-alignment-direction="column"]::before {
    inset: 0 auto 0 50%;
    border-block-start: 0;
    border-inline-start: calc(var(--mantine-scale) * 1px) dashed currentColor;
  }

  .myoxus-mermaid-gfx-alignment-anchor {
    position: absolute;
    width: var(--mantine-spacing-xs);
    height: var(--mantine-spacing-xs);
    padding: 0;
    border: calc(var(--mantine-scale) * 1px) solid currentColor;
    border-radius: var(--mantine-radius-xl);
    background: ${cssVar("backgroundPrimaryColor")};
    color: ${cssVar("warningColor")};
    pointer-events: auto;
  }

  .myoxus-mermaid-gfx-alignment-anchor[data-alignment-direction="row"] {
    transform: translate(-50%, calc(-50% + var(--mantine-spacing-xs)));
  }

  .myoxus-mermaid-gfx-alignment-anchor[data-alignment-direction="column"] {
    transform: translate(calc(-50% + var(--mantine-spacing-xs)), -50%);
  }

  .myoxus-mermaid-gfx-alignment-anchor:focus-visible {
    outline: calc(var(--mantine-scale) * 2px) solid
      ${cssVar("primaryColor")};
    outline-offset: calc(var(--mantine-scale) * 2px);
  }

  .myoxus-mermaid-gfx-connection-preview path {
    fill: none;
    stroke: ${cssVar("textSecondaryColor")};
    stroke-width: 2.5;
    stroke-dasharray: 8 7;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }

  .myoxus-mermaid-gfx-connection-preview[data-valid-target="true"] path {
    stroke: ${cssVar("primaryColor")};
    stroke-dasharray: none;
  }

  .myoxus-mermaid-gfx-connection-preview-source,
  .myoxus-mermaid-gfx-connection-preview-target {
    fill: ${cssVar("backgroundPrimaryColor")};
    stroke: ${cssVar("textSecondaryColor")};
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .myoxus-mermaid-gfx-connection-preview[data-valid-target="true"]
    .myoxus-mermaid-gfx-connection-preview-target {
    fill: ${cssVar("primaryColor")};
    stroke: ${cssVar("backgroundPrimaryColor")};
  }

  .myoxus-mermaid-gfx-connection-diagnostic {
    position: absolute;
    z-index: 19;
    max-width: min(28ch, 50%);
    padding: var(--mantine-spacing-xs);
    border: calc(var(--mantine-scale) * 1px) solid
      ${cssVar("warningColor")};
    border-radius: var(--mantine-radius-sm);
    background: ${cssVar("backgroundPrimaryColor")};
    color: ${cssVar("textPrimaryColor")};
    font-size: var(--mantine-font-size-xs);
    pointer-events: none;
    transform: translate(var(--mantine-spacing-xs), var(--mantine-spacing-xs));
  }

  .myoxus-mermaid-gfx-subgraph-drop-preview {
    position: absolute;
    z-index: 19;
    border: calc(var(--mantine-scale) * 2px) dashed var(--myoxus-primary-color);
    border-radius: var(--mantine-radius-sm);
    background: color-mix(
      in srgb,
      var(--myoxus-primary-color) 12%,
      transparent
    );
    box-shadow: var(--mantine-shadow-sm);
    pointer-events: none;
  }

  .myoxus-mermaid-gfx-connect-handle,
  .myoxus-mermaid-gfx-edge-handle,
  .myoxus-mermaid-gfx-resize-handle,
  .myoxus-mermaid-gfx-subgraph-resize-handle {
    position: absolute;
    z-index: 20;
    width: calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs));
    height: calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs));
    border: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    border-radius: var(--mantine-radius-xl);
    background: ${cssVar("backgroundPrimaryColor")};
    box-shadow: var(--mantine-shadow-sm);
    cursor: crosshair;
    transform: translate(-50%, -50%);
    touch-action: none;
  }

  .myoxus-mermaid-gfx-resize-handle,
  .myoxus-mermaid-gfx-subgraph-resize-handle {
    border-radius: var(--mantine-radius-xs);
    cursor: nwse-resize;
  }

  .myoxus-mermaid-gfx-edge-handle {
    border-color: var(--myoxus-edgeless-frame-border-color);
    cursor: grab;
  }

  .myoxus-mermaid-gfx-subgraph-move-handle {
    position: absolute;
    z-index: 15;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: grab;
    touch-action: none;
  }

  .myoxus-mermaid-gfx-subgraph-move-handle:active {
    cursor: grabbing;
  }

  .myoxus-mermaid-gfx-subgraph-move-handle:focus-visible {
    outline: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    outline-offset: calc(var(--mantine-scale) * 2px);
  }

  .myoxus-mermaid-gfx-connect-handle::after,
  .myoxus-mermaid-gfx-edge-handle::after,
  .myoxus-mermaid-gfx-resize-handle::after,
  .myoxus-mermaid-gfx-subgraph-resize-handle::after {
    position: absolute;
    inset: var(--mantine-spacing-2xs);
    border-radius: inherit;
    background: var(--myoxus-primary-color);
    content: "";
  }

  .myoxus-mermaid-gfx-connect-handle {
    width: calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs));
    height: calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs));
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  .myoxus-mermaid-gfx-connect-handle::after {
    inset: var(--mantine-spacing-sm);
    border: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    background: ${cssVar("backgroundPrimaryColor")};
    box-shadow: var(--mantine-shadow-sm);
  }

  .myoxus-mermaid-gfx-connect-handle:focus-visible {
    outline: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    outline-offset: calc(var(--mantine-scale) * 2px);
  }

  .myoxus-mermaid-gfx-edge-handle:focus-visible,
  .myoxus-mermaid-gfx-resize-handle:focus-visible,
  .myoxus-mermaid-gfx-subgraph-resize-handle:focus-visible {
    outline: calc(var(--mantine-scale) * 2px) solid var(--myoxus-primary-color);
    outline-offset: calc(var(--mantine-scale) * 2px);
  }

`;

const mounted = new WeakMap<
  Document | ShadowRoot,
  {
    element: HTMLStyleElement;
    count: number;
  }
>();

export function mountMermaidBlockStyles(block: HTMLElement) {
  const root = block.getRootNode();
  const scope = root instanceof ShadowRoot ? root : block.ownerDocument;
  let entry = mounted.get(scope);
  if (!entry) {
    const element = block.ownerDocument.createElement("style");
    element.textContent = mermaidBlockStyles;
    (scope instanceof ShadowRoot ? scope : scope.head).append(element);
    entry = { element, count: 0 };
    mounted.set(scope, entry);
  }
  entry.count++;
  return () => {
    if (--entry.count) return;
    entry.element.remove();
    mounted.delete(scope);
  };
}
