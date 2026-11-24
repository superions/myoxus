// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { installEditorStyles } from "@virgultum/core/runtime";

export function installPreviewStyles(anchor: HTMLElement | null) {
  if (anchor) installEditorStyles(anchor, styles);
}

const styles = `
.html-preview-iframe {
  width: 100%;
  height: calc(
    456px + var(--mantine-spacing-2xl) + var(--mantine-spacing-sm) +
      var(--mantine-spacing-xl)
  );
  border: 0;
}

.editor-vector-preview {
  position: relative;
}

.editor-vector-viewport {
  min-height: 300px;
  max-height: 600px;
  display: grid;
  place-items: center;
  padding: var(--mantine-spacing-md);
  overflow: hidden;
  user-select: none;
  cursor: grab;
}

.editor-vector-preview--typst .editor-vector-viewport {
  min-height: 320px;
  max-height: calc(
    456px + var(--mantine-spacing-2xl) * 3 + var(--mantine-spacing-sm)
  );
  overflow: auto;
}

.editor-vector-viewport:active {
  cursor: grabbing;
}

.editor-vector-svg {
  display: flex;
  justify-content: center;
  width: 100%;
  transition: transform 120ms ease-out;
}

.editor-vector-controls,
.editor-vector-scale {
  position: absolute;
}

.editor-vector-controls {
  inset-block-start: var(--mantine-spacing-xs);
  inset-inline-end: var(--mantine-spacing-xs);
}

.editor-vector-scale {
  inset-block-end: var(--mantine-spacing-xs);
  inset-inline-start: var(--mantine-spacing-xs);
}
`;
