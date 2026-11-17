import {
  MYOXUS_SCROLL_ANCHORING_WIDGET,
  MyoxusScrollAnchoringWidget,
} from "./scroll-anchoring.js";

export function effects() {
  customElements.define(
    MYOXUS_SCROLL_ANCHORING_WIDGET,
    MyoxusScrollAnchoringWidget,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_SCROLL_ANCHORING_WIDGET]: MyoxusScrollAnchoringWidget;
  }
}
