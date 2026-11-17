import { ListBlockComponent } from "./list-block.js";

export function effects() {
  customElements.define("myoxus-list", ListBlockComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-list": ListBlockComponent;
  }
}
