import { NativeViewElement } from "../../primitives/env/index.js";
import type { Rect } from "../../primitives/gfx/index.js";

export class DropIndicator extends NativeViewElement {
  private readonly mark = this.ownerDocument.createElement("div");
  private bounds: Rect | null = null;
  private layer = 2;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = `
    .myoxus-drop-indicator {
      position: absolute;
      top: 0;
      left: 0;
      background: var(--myoxus-primary-color);
      transition-property: height, transform;
      transition-duration: 100ms;
      transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
      transition-delay: 0s;
      transform-origin: 0 0;
      pointer-events: none;
      z-index: 2;
    }
  `;
    shadow.append(style);
    this.mark.className = "myoxus-drop-indicator";
  }

  get rect() {
    return this.bounds;
  }
  set rect(value: Rect | null) {
    this.bounds = value;
    if (!value) {
      this.mark.remove();
      return;
    }
    Object.assign(this.mark.style, {
      left: value.left + "px",
      top: value.top + "px",
      width: value.width + "px",
      height: value.height + "px",
      zIndex: String(this.layer),
    });
    if (!this.mark.parentNode) this.shadowRoot!.append(this.mark);
  }

  get zIndex() {
    return this.layer;
  }
  set zIndex(value: number) {
    this.layer = value;
    this.mark.style.zIndex = String(value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-drop-indicator": DropIndicator;
  }
}
