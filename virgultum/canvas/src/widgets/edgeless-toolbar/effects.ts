import {
  EDGELESS_TOOLBAR_WIDGET,
  EdgelessToolbarWidget,
} from "./edgeless-toolbar";

export function effects() {
  customElements.define(EDGELESS_TOOLBAR_WIDGET, EdgelessToolbarWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-toolbar-widget": EdgelessToolbarWidget;
  }
}
