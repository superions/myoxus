import { MyoxusReference } from "./reference-node";

export function effects() {
  customElements.define("myoxus-reference", MyoxusReference);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-reference": MyoxusReference;
  }
}
