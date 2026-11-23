// SPDX-License-Identifier: AGPL-3.0-or-later

import { effect } from "@preact/signals-core";
import { cssVar } from "@myoxus/theme";
import { DefaultModeDragType } from "@virgultum/canvas-runtime/surface";
import type { GfxController } from "@virgultum/core/runtime/gfx";

import { MermaidPageSelectionTool } from "./mermaid-page-selection-tool.js";

export function mountMermaidPageDraggingArea(
  anchor: HTMLElement,
  gfx: GfxController,
) {
  const area = anchor.ownerDocument.createElement("div");
  area.className = "myoxus-mermaid-page-dragging-area";
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, {
    position: "absolute",
    zIndex: "1",
    boxSizing: "border-box",
    border: `1px solid ${cssVar("primaryColor")}`,
    background: cssVar("primaryColor04"),
    pointerEvents: "none",
  });
  const unsubscribe = effect(() => {
    const tool = gfx.tool.currentTool$.value;
    const rect = gfx.tool.draggingViewportArea$.value;
    if (
      !(tool instanceof MermaidPageSelectionTool) ||
      !tool.movementDragging ||
      tool.dragType !== DefaultModeDragType.Selecting ||
      rect.w === 0 ||
      rect.h === 0
    ) {
      area.remove();
      return;
    }
    Object.assign(area.style, {
      height: `${rect.h}px`,
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
    });
    if (!area.isConnected) anchor.append(area);
  });
  return () => {
    unsubscribe();
    area.remove();
  };
}
