// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mermaid-block.styles.ts` — P-VIRG-ARCH-I-04b
 * extracted the `static override styles = css\`...\``
 * template literal from `mermaid-block.ts`.
 *
 * **Why a sibling file, not an inline body.** The
 * `css\`...\`` block in `mermaid-block.ts` spans
 * 829 LoC (Z. 260-1088 of the pre-I-04b file). That
 * is roughly 8% of the entire block class, and the
 * Mermaid block is the largest file in the editor
 * (`block-mermaid`). I-04b relocates the body
 * verbatim to this sibling and turns the class
 * field into a one-line reference. The class file
 * loses 829 LoC and the styles become individually
 * diff-able, lint-able, and re-viewable.
 *
 * **No new runtime behaviour.** The byte-for-byte
 * copy uses the same `css` tagged template import
 * from `lit`, the same `unsafeCSSVar` calls
 * (imported from `@virgultum/shared/theme`), the
 * same selector order, and the same closing
 * backtick positioning. Lit's `css` returns a
 * `CSSResult` regardless of where the call site
 * lives, so the resulting `static styles` value
 * is identical.
 *
 * **Why `static override styles` still works with
 * an imported value.** Lit's `LitElement` declares
 * `static styles: CSSResultGroup`. The class field
 * override in `mermaid-block.ts` is rewritten from
 * the 829-LoC template literal to a single
 * identifier (`mermaidBlockStyles`) that resolves
 * to a `CSSResult` at class-evaluation time. Lit
 * reads the field once per class definition, not
 * per instance, so the import-then-reference shape
 * is semantically equivalent to the inline
 * `static override styles = css\`...\`` declaration.
 *
 * **Why a single export, not a namespace.** The
 * `database-block-styles.ts` sibling uses the
 * `css({...})` object syntax to expose a flat set
 * of class-name strings (`databaseBlockStyles`,
 * `databaseBlockHeader`, …). The Mermaid CSS is a
 * single 829-LoC template body; there is nothing
 * to namespace. A single `mermaidBlockStyles`
 * named export is the minimal API surface and
 * matches the `unsafeCSSVar` import shape.
 *
 * **Dependencies of the new file.**
 * - `lit` exports the `css` tagged template
 * - `@virgultum/shared/theme` exports
 *   `unsafeCSSVar`, which is the only
 *   function-call interpolation in the body.
 *
 * The block file imports from this sibling
 * (`./mermaid-block.styles.js`) and the smoke
 * spec does not (it does not consume styles).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §I
 *      (P-VIRG-ARCH-I-04b)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04b closeout)
 */

import { unsafeCSSVar } from "@virgultum/shared/theme";
import { css } from "lit";

/**
 * Static CSS for `MermaidBlockComponent`. The
 * `CSSResult` is consumed by the class field
 * `static override styles` in
 * `mermaid-block.ts`. All selectors are scoped
 * to the `.myoxus-mermaid-*` class prefix
 * (`myoxus-` is the myoxus-owned namespace) and
 * rely on Lit's shadow-DOM scoping; no global
 * selectors leak.
 *
 * The body is intentionally one literal — Lit's
 * `unsafeCSS`/`css` only dedupes across separate
 * `CSSResult` values when the template is a single
 * argument. Splitting the body into multiple
 * `css\`...\`` calls and concatenating would
 * defeat Lit's style-construction caching and
 * would re-introduce byte-for-byte diff noise.
 */
export const mermaidBlockStyles = css`
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

  .myoxus-mermaid-visual-editor {
    border-top: 1px solid ${unsafeCSSVar("borderColor")};
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
  }

  .myoxus-mermaid-display-preview {
    display: grid;
    overflow: hidden;
    border: 1px solid ${unsafeCSSVar("borderColor")};
    border-radius: var(--mantine-radius-md);
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
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

  .myoxus-mermaid-visual-canvas {
    --myoxus-mermaid-canvas-background: ${unsafeCSSVar("noteBackgroundWhite")};
    --myoxus-background-primary-color: var(--myoxus-mermaid-canvas-background);
    --myoxus-text-primary-color: ${unsafeCSSVar("textPrimaryColor")};

    display: block;
    width: 100%;
    min-height: calc(var(--myoxus-typography-body-line-height) * 13);
    touch-action: none;
    background-color: var(--myoxus-mermaid-canvas-background);
    background-image: radial-gradient(
      var(--myoxus-edgeless-grid-color) 1px,
      transparent 1px
    );
    background-size: 18px 18px;
  }

  .myoxus-mermaid-gfx-editor {
    display: grid;
    min-height: var(
      --myoxus-mermaid-gfx-viewport-height,
      calc(var(--myoxus-typography-body-line-height) * 18)
    );
    grid-template-rows: auto minmax(0, 1fr);
    border-top: 1px solid ${unsafeCSSVar("borderColor")};
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
  }

  .myoxus-mermaid-gfx-editor[data-mermaid-display-mode="display"] {
    border-top: 0;
    background: transparent;
  }

  [data-mermaid-edgeless-embedded="true"]
    .myoxus-mermaid-gfx-editor[data-mermaid-gfx-surface="true"]
    > .myoxus-mermaid-gfx-viewport,
  .myoxus-mermaid-gfx-editor > .myoxus-mermaid-gfx-viewport {
    --myoxus-mermaid-canvas-background: ${unsafeCSSVar("noteBackgroundWhite")};
    --myoxus-background-primary-color: var(--myoxus-mermaid-canvas-background);
    --myoxus-text-primary-color: ${unsafeCSSVar("textPrimaryColor")};

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
    background-size: 18px 18px;
    container-name: viewport;
    container-type: inline-size;
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
    border-top: 1px solid ${unsafeCSSVar("borderColor")};
    background: ${unsafeCSSVar("backgroundSecondaryColor")};
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
    background: ${unsafeCSSVar("borderColor")};
    content: "";
  }

  .myoxus-mermaid-viewport-resize-handle:hover::before,
  .myoxus-mermaid-viewport-resize-handle:focus-visible::before {
    background: ${unsafeCSSVar("primaryColor")};
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
      ${unsafeCSSVar("primaryColor")};
    border-radius: var(--mantine-radius-sm);
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    color: ${unsafeCSSVar("textPrimaryColor")};
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
      ${unsafeCSSVar("primaryColor")};
    border-radius: var(--mantine-radius-sm);
  }

  .myoxus-mermaid-gfx-selection-bounds {
    box-sizing: border-box;
    border: calc(var(--mantine-scale) * 1px) dashed
      ${unsafeCSSVar("primaryColor")};
    border-radius: var(--mantine-radius-sm);
  }

  .myoxus-mermaid-gfx-selection-bounds > span {
    position: absolute;
    inset-inline-start: 0;
    inset-block-start: 0;
    padding: var(--mantine-spacing-xs);
    border-radius: var(--mantine-radius-sm);
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    color: ${unsafeCSSVar("textPrimaryColor")};
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

  .myoxus-mermaid-gfx-alignment-guide {
    position: absolute;
    color: ${unsafeCSSVar("warningColor")};
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
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    color: ${unsafeCSSVar("warningColor")};
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
      ${unsafeCSSVar("primaryColor")};
    outline-offset: calc(var(--mantine-scale) * 2px);
  }

  .myoxus-mermaid-gfx-connection-preview path {
    fill: none;
    stroke: ${unsafeCSSVar("textSecondaryColor")};
    stroke-width: 2.5;
    stroke-dasharray: 8 7;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }

  .myoxus-mermaid-gfx-connection-preview[data-valid-target="true"] path {
    stroke: ${unsafeCSSVar("primaryColor")};
    stroke-dasharray: none;
  }

  .myoxus-mermaid-gfx-connection-preview-source,
  .myoxus-mermaid-gfx-connection-preview-target {
    fill: ${unsafeCSSVar("backgroundPrimaryColor")};
    stroke: ${unsafeCSSVar("textSecondaryColor")};
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .myoxus-mermaid-gfx-connection-preview[data-valid-target="true"]
    .myoxus-mermaid-gfx-connection-preview-target {
    fill: ${unsafeCSSVar("primaryColor")};
    stroke: ${unsafeCSSVar("backgroundPrimaryColor")};
  }

  .myoxus-mermaid-gfx-connection-diagnostic {
    position: absolute;
    z-index: 19;
    max-width: min(28ch, 50%);
    padding: var(--mantine-spacing-xs);
    border: calc(var(--mantine-scale) * 1px) solid
      ${unsafeCSSVar("warningColor")};
    border-radius: var(--mantine-radius-sm);
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    color: ${unsafeCSSVar("textPrimaryColor")};
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
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
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
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
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

  .myoxus-mermaid-gfx-context-menu {
    position: absolute;
    z-index: 30;
    min-width: 24ch;
    max-width: min(36ch, calc(100% - var(--mantine-spacing-xl)));
    border: 1px solid ${unsafeCSSVar("borderColor")};
    border-radius: var(--mantine-radius-md);
    background: ${unsafeCSSVar("backgroundPrimaryColor")};
    box-shadow: var(--mantine-shadow-md);
    color: ${unsafeCSSVar("textPrimaryColor")};
    padding: var(--mantine-spacing-2xs);
    transform: translate(0, 0);
  }

  .myoxus-mermaid-gfx-context-menu button {
    display: block;
    width: 100%;
    border: 0;
    border-radius: var(--mantine-radius-sm);
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-family: var(--myoxus-typography-body-small-family);
    font-size: var(--myoxus-typography-body-small-size);
    font-style: var(--myoxus-typography-body-small-font-style);
    font-weight: var(--myoxus-typography-body-small-weight);
    letter-spacing: var(--myoxus-typography-body-small-letter-spacing);
    line-height: var(--myoxus-typography-body-small-line-height);
    padding: var(--mantine-spacing-2xs) var(--mantine-spacing-xs);
    text-align: left;
  }

  .myoxus-mermaid-gfx-context-menu button:hover,
  .myoxus-mermaid-gfx-context-menu button:focus-visible {
    background: ${unsafeCSSVar("backgroundSecondaryColor")};
    outline: none;
  }

  .myoxus-mermaid-visual-canvas text {
    font-family: var(--myoxus-typography-body-family);
  }

  .myoxus-mermaid-visual-node {
    cursor: pointer;
  }

  .myoxus-mermaid-visual-node[data-selected="true"] rect,
  .myoxus-mermaid-visual-node[data-selected="true"] polygon {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-visual-edge {
    cursor: pointer;
  }

  .myoxus-mermaid-visual-edge[data-selected="true"] line {
    stroke: var(--myoxus-primary-color);
    stroke-width: 4px;
  }

  .myoxus-mermaid-visual-resize-handle {
    cursor: nwse-resize;
  }

  .myoxus-mermaid-class-node {
    cursor: grab;
  }

  .myoxus-mermaid-class-node:active {
    cursor: grabbing;
  }

  .myoxus-mermaid-class-node[data-selected="true"] rect {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-class-relation {
    cursor: pointer;
  }

  .myoxus-mermaid-class-relation[data-selected="true"] line {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-er-entity {
    cursor: grab;
  }

  .myoxus-mermaid-er-entity:active {
    cursor: grabbing;
  }

  .myoxus-mermaid-er-entity[data-selected="true"] rect {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-er-relationship {
    cursor: pointer;
  }

  .myoxus-mermaid-er-relationship[data-selected="true"] line {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-block-node,
  .myoxus-mermaid-block-edge {
    cursor: pointer;
  }

  .myoxus-mermaid-block-node[data-selected="true"] rect {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-block-edge[data-selected="true"] line {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-requirement-card,
  .myoxus-mermaid-requirement-relation {
    cursor: pointer;
  }

  .myoxus-mermaid-requirement-card[data-selected="true"] rect {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-requirement-relation[data-selected="true"] line {
    stroke: var(--myoxus-primary-color);
    stroke-width: 3px;
  }

  .myoxus-mermaid-state {
    max-width: 45ch;
    color: ${unsafeCSSVar("textSecondaryColor")};
    font-family: var(--myoxus-typography-body-small-family);
    font-size: var(--myoxus-typography-body-small-size);
    font-style: var(--myoxus-typography-body-small-font-style);
    font-weight: var(--myoxus-typography-body-small-weight);
    letter-spacing: var(--myoxus-typography-body-small-letter-spacing);
    line-height: var(--myoxus-typography-body-small-line-height);
    text-align: center;
  }

  .myoxus-mermaid-state strong {
    display: block;
    margin-bottom: var(--mantine-spacing-2xs);
    color: ${unsafeCSSVar("textPrimaryColor")};
    font-family: var(--myoxus-typography-card-title-family);
    font-size: var(--myoxus-typography-card-title-size);
    font-style: var(--myoxus-typography-card-title-font-style);
    font-weight: var(--myoxus-typography-card-title-weight);
    letter-spacing: var(--myoxus-typography-card-title-letter-spacing);
    line-height: var(--myoxus-typography-card-title-line-height);
  }
`;
