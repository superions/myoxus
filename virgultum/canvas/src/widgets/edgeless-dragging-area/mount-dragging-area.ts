// SPDX-License-Identifier: AGPL-3.0-or-later
import { cssVar } from "@myoxus/theme";
import { effect } from "@preact/signals-core";
import {
  DefaultModeDragType,
  DefaultTool,
} from "@virgultum/canvas-runtime/surface";
import type { GfxController } from "@virgultum/core/runtime/gfx";

/** Paint the drag rectangle in viewport coordinates while leaving hit testing to the tool. */
export function mountCanvasDraggingArea(
  overlay: HTMLElement,
  tools: GfxController["tool"],
  before: Element | null,
) {
  const mark = overlay.ownerDocument.createElement("div");
  mark.className = "myoxus-edgeless-dragging-area";
  Object.assign(mark.style, {
    position: "absolute",
    boxSizing: "border-box",
    pointerEvents: "none",
    zIndex: "1",
    background: cssVar("primaryColor04"),
    border: `1px solid ${cssVar("primaryColor")}`,
  });

  const stop = effect(() => {
    const active = tools.currentTool$.value;
    const bounds = tools.draggingViewportArea$.value;
    if (
      !(active instanceof DefaultTool) ||
      active.dragType !== DefaultModeDragType.Selecting ||
      !bounds.w ||
      !bounds.h
    ) {
      mark.remove();
      return;
    }

    Object.assign(mark.style, {
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.w}px`,
      height: `${bounds.h}px`,
    });
    if (!mark.parentNode)
      overlay.insertBefore(
        mark,
        before?.parentNode === overlay ? before : null,
      );
  });

  return () => {
    stop();
    mark.remove();
  };
}
