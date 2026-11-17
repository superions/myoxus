import { MyoxusText } from "./nodes/myoxus-text";
import { InlineAnnotation } from "./nodes/annotation";
import { InlineDocumentField } from "./nodes/document-field";

export function effects() {
  customElements.define("myoxus-text", MyoxusText);
  customElements.define("myoxus-inline-annotation", InlineAnnotation);
  customElements.define("myoxus-inline-document-field", InlineDocumentField);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-text": MyoxusText;
    "myoxus-inline-annotation": InlineAnnotation;
    "myoxus-inline-document-field": InlineDocumentField;
  }
}
