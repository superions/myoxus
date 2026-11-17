import { effects as ParagraphHeadingIconEffects } from "./heading-icon.js";
import { ParagraphBlockComponent } from "./paragraph-block.js";

export function effects() {
  ParagraphHeadingIconEffects();
  customElements.define("myoxus-paragraph", ParagraphBlockComponent);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-paragraph": ParagraphBlockComponent;
  }
}
