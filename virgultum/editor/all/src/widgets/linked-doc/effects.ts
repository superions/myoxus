import { MYOXUS_LINKED_DOC_WIDGET } from "./config.js";
import { MyoxusLinkedDocWidget } from "./index.js";
import { MyoxusMobileLinkedDocMenu } from "./mobile-linked-doc-menu.js";

export function effects() {
  customElements.define(MYOXUS_LINKED_DOC_WIDGET, MyoxusLinkedDocWidget);
  customElements.define(
    "myoxus-mobile-linked-doc-menu",
    MyoxusMobileLinkedDocMenu,
  );
}
