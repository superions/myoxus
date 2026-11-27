// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EdgelessLegacySlotIdentifier } from "@virgultum/canvas-runtime/surface";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  EditorChromeHostIdentifier,
  type EditorCanvasToolbarItem,
} from "@virgultum/core/services";
import { stopPropagation } from "@virgultum/core/utils";

import {
  QuickToolIdentifier,
  SeniorToolIdentifier,
} from "./extension/index.js";

/** Preserved host tag name queried by root hit-testing, Mermaid dock clearance, and E2E locators. */
export const EDGELESS_TOOLBAR_WIDGET = "edgeless-toolbar-widget";

const dockGeometryCss = `
edgeless-toolbar-widget {
  position: absolute;
  z-index: 1;
  left: 50%;
  transform: translateX(-50%);
  bottom: 0;
  width: 100%;
  pointer-events: none;
}
edgeless-toolbar-widget > .edgeless-toolbar-wrapper {
  display: flex;
  justify-content: center;
}
edgeless-toolbar-widget .edgeless-toolbar-toggle-control {
  pointer-events: none;
  padding-bottom: 16px;
  max-width: calc(100% - 128px);
}
edgeless-toolbar-widget .edgeless-toolbar-toggle-control [role="toolbar"] {
  pointer-events: auto;
}
edgeless-toolbar-widget .edgeless-toolbar-toggle-control[data-enable="true"] {
  pointer-events: auto;
  transition: 0.23s ease;
  padding-top: 100px;
  transform: translateY(100px);
}
edgeless-toolbar-widget
  .edgeless-toolbar-toggle-control[data-enable="true"]:hover,
edgeless-toolbar-widget
  .edgeless-toolbar-toggle-control[data-enable="true"]:focus-within {
  padding-top: 0;
  transform: translateY(0);
}
edgeless-toolbar-widget[disabled] .edgeless-toolbar-container {
  pointer-events: none;
}
`;

/**
 * Mounts the React Edgeless canvas dock directly onto the root overlay inside
 * a plain `<edgeless-toolbar-widget>` host element without registering a custom
 * element class.
 */
export function mountCanvasDock(
  edgeless: BlockComponent,
  overlay: HTMLElement,
): () => void {
  const chrome = edgeless.std.getOptional(EditorChromeHostIdentifier);
  if (!chrome?.mountCanvasDock) return () => {};

  const doc = overlay.ownerDocument;
  const host = doc.createElement(EDGELESS_TOOLBAR_WIDGET);
  const style = doc.createElement("style");
  style.textContent = dockGeometryCss;
  const wrapper = doc.createElement("div");
  wrapper.className = "edgeless-toolbar-wrapper";
  const anchor = doc.createElement("div");
  anchor.className = "edgeless-toolbar-toggle-control";
  anchor.dataset.enable = "false";

  const stopEvents = ["dblclick", "mousedown", "pointerdown"] as const;
  for (const event of stopEvents) {
    anchor.addEventListener(event, stopPropagation);
  }

  wrapper.append(anchor);
  host.append(style, wrapper);
  overlay.append(host);

  const slots = edgeless.std.get(EdgelessLegacySlotIdentifier);
  const lockSub = slots.toolbarLocked.subscribe((disabled) => {
    host.toggleAttribute("disabled", disabled);
  });

  const resolveTools = (closeActivePopover: () => void) => {
    const gfx = edgeless.std.get(GfxControllerIdentifier);
    const quickTools = Array.from(
      edgeless.std.provider.getAll(QuickToolIdentifier).values(),
    );
    const seniorTools = Array.from(
      edgeless.std.provider.getAll(SeniorToolIdentifier).values(),
    );

    const quick: EditorCanvasToolbarItem[] = quickTools
      .map((builder) => builder({ block: edgeless, gfx, closeActivePopover }))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .filter(({ enable = true }) => enable)
      .map((tool) => ({
        ...tool.content,
        menu: tool.menu,
      }));

    const senior: EditorCanvasToolbarItem[] = seniorTools
      .map((builder) => builder({ block: edgeless, gfx, closeActivePopover }))
      .filter(({ enable = true }) => enable)
      .map((tool) => tool.content);

    return { quick, senior };
  };

  const unmount = chrome.mountCanvasDock(anchor, {
    edgeless,
    anchor,
    resolveTools,
  });

  return () => {
    unmount();
    lockSub.unsubscribe();
    for (const event of stopEvents) {
      anchor.removeEventListener(event, stopPropagation);
    }
    host.remove();
  };
}
