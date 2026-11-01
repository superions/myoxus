import { MyoxusMention } from "./myoxus-mention";

export function effects() {
  customElements.define("myoxus-mention", MyoxusMention);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-mention": MyoxusMention;
  }
}
