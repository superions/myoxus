import type { RootBlockModel } from "@virgultum/core/models";
import {
  NativeEditorWidget,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
export const MYOXUS_VIEWPORT_OVERLAY_WIDGET = "myoxus-viewport-overlay-widget";

export class MyoxusViewportOverlayWidget extends NativeEditorWidget<RootBlockModel> {
  private readonly overlay = document.createElement("div");

  override connectedCallback() {
    super.connectedCallback();
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    this.overlay.className = "myoxus-viewport-overlay-widget";
    Object.assign(this.overlay.style, {
      position: "absolute",
      top: "0",
      left: "0",
      zIndex: "calc(var(--myoxus-z-index-popover) - 1)",
    });
    root.replaceChildren(this.overlay);
    this.setLocked(this.locked);
    for (const event of ["dragStart", "pointerDown", "click"] as const) {
      this.handleEvent(event, () => this.locked, { global: true });
    }
  }

  private locked = false;
  private setLocked(locked: boolean) {
    this.locked = locked;
    this.overlay.classList.toggle("lock", locked);
    Object.assign(this.overlay.style, {
      width: locked ? "100vw" : "0",
      height: locked ? "100%" : "0",
      pointerEvents: locked ? "auto" : "none",
    });
  }
  lock() {
    this.setLocked(true);
  }
  toggleLock() {
    this.setLocked(!this.locked);
  }
  unlock() {
    this.setLocked(false);
  }
}

export const viewportOverlayWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_VIEWPORT_OVERLAY_WIDGET,
  MYOXUS_VIEWPORT_OVERLAY_WIDGET,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_VIEWPORT_OVERLAY_WIDGET]: MyoxusViewportOverlayWidget;
  }
}
