import { MYOXUS_TOOLBAR_WIDGET, MyoxusToolbarWidget } from "./toolbar";

export function effects() {
  customElements.define(MYOXUS_TOOLBAR_WIDGET, MyoxusToolbarWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_TOOLBAR_WIDGET]: MyoxusToolbarWidget;
  }
}
