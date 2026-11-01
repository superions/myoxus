import { MYOXUS_LINKED_DOC_WIDGET } from "./config.js";
import { ImportDoc } from "./import-doc/import-doc.js";
import { Loader } from "./import-doc/loader.js";
import { MyoxusLinkedDocWidget } from "./index.js";
import { LinkedDocPopover } from "./linked-doc-popover.js";
import { MyoxusMobileLinkedDocMenu } from "./mobile-linked-doc-menu.js";

export function effects() {
  customElements.define("myoxus-linked-doc-popover", LinkedDocPopover);
  customElements.define(MYOXUS_LINKED_DOC_WIDGET, MyoxusLinkedDocWidget);
  customElements.define("import-doc", ImportDoc);
  customElements.define(
    "myoxus-mobile-linked-doc-menu",
    MyoxusMobileLinkedDocMenu,
  );
  customElements.define("loader-element", Loader);
}
