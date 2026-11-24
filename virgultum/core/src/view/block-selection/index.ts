import { NativeViewElement } from "../../primitives/env/index.js";
import { installEditorStyles } from "../../runtime/view/element/native-block-component.js";
const selectionStyle = `
    myoxus-block-selection {
      position: absolute;
      z-index: 1;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      /* The server hover role is an opaque surface, not an overlay tint.
         Outline selection without covering document text or annotation paper. */
      background-color: transparent;
      outline: 1px solid var(--myoxus-brand-color);
      border-color: transparent;
      border-style: solid;
    }
  `;
export class BlockSelection extends NativeViewElement {
  private active = false;
  get selected() {
    return this.active;
  }
  set selected(value: boolean) {
    this.active = value;
    this.style.display = value ? "block" : "none";
  }
  borderRadius = 5;
  borderWidth = 0;
  connectedCallback() {
    installEditorStyles(this, selectionStyle);
    this.selected = this.active;
    this.style.borderRadius = this.borderRadius + "px";
    this.style.borderWidth = this.borderWidth + "px";
    if (this.borderWidth) {
      this.style.boxSizing = "content-box";
      this.style.transform =
        "translate(-" + this.borderWidth + "px,-" + this.borderWidth + "px)";
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-block-selection": BlockSelection;
  }
}
