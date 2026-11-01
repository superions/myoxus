import { MyoxusText } from "./nodes/myoxus-text";
import { InlineAnnotation } from "./nodes/annotation";

export function effects() {
  customElements.define("myoxus-text", MyoxusText);
  customElements.define("myoxus-inline-annotation", InlineAnnotation);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-text": MyoxusText;
    "myoxus-inline-annotation": InlineAnnotation;
  }
}
