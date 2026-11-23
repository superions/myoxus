// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ResizeHandle } from "@virgultum/core/runtime/gfx";

type HandleAction = "resize" | "rotate";

export class CanvasResizeHandles {
  private readonly handles = new Map<
    ResizeHandle,
    {
      element: HTMLDivElement;
      resize: HTMLDivElement;
      rotate: HTMLDivElement;
    }
  >();

  constructor(private readonly document: Document) {}

  private create(handle: ResizeHandle) {
    const element = this.document.createElement("div");
    const resize = this.document.createElement("div");
    const rotate = this.document.createElement("div");
    element.className = "handle";
    element.setAttribute("aria-label", handle);
    resize.className = "resize transparent-handle";
    rotate.className = "rotate";
    element.append(resize);
    const entry = { element, resize, rotate };
    this.handles.set(handle, entry);
    return entry;
  }

  /** Keep hit targets stable as the viewport and selection bounds update during a drag. */
  update(
    directions: readonly ResizeHandle[],
    rotatable: boolean,
    onDrag: (
      event: PointerEvent,
      handle: ResizeHandle,
      action: HandleAction,
    ) => void,
    cursor: (action: HandleAction, handle: ResizeHandle) => string,
  ) {
    for (const [handle, { element }] of this.handles) {
      if (directions.includes(handle)) continue;
      element.onpointerdown = null;
      this.handles.delete(handle);
    }

    return directions.map((handle) => {
      const { element, resize, rotate } =
        this.handles.get(handle) ?? this.create(handle);
      if (rotatable && handle.includes("-")) {
        if (!rotate.parentNode) element.prepend(rotate);
        rotate.style.cursor = cursor("rotate", handle);
      } else {
        rotate.remove();
      }
      resize.style.cursor = cursor("resize", handle);
      element.onpointerdown = (event) => {
        event.stopPropagation();
        onDrag(event, handle, event.target === rotate ? "rotate" : "resize");
      };
      return element;
    });
  }

  clear() {
    for (const { element } of this.handles.values())
      element.onpointerdown = null;
    this.handles.clear();
  }
}
