import { ParagraphBlockComponent } from "./paragraph-block.js";

export function effects() {
  customElements.define("myoxus-paragraph", ParagraphBlockComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-paragraph": ParagraphBlockComponent;
  }
}
