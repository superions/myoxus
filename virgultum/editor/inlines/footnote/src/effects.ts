import { MyoxusFootnoteNode } from "./footnote-node/footnote-node";

export function effects() {
  customElements.define("myoxus-footnote-node", MyoxusFootnoteNode);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-footnote-node": MyoxusFootnoteNode;
  }
}
