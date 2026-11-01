import {
  MYOXUS_EDGELESS_ZOOM_TOOLBAR_WIDGET,
  MyoxusEdgelessZoomToolbarWidget,
} from ".";

export function effects() {
  customElements.define(
    MYOXUS_EDGELESS_ZOOM_TOOLBAR_WIDGET,
    MyoxusEdgelessZoomToolbarWidget,
  );
}
