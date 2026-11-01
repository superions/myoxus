import {
  MYOXUS_VIEWPORT_OVERLAY_WIDGET,
  MyoxusViewportOverlayWidget,
} from "./index";

export function effects() {
  customElements.define(
    MYOXUS_VIEWPORT_OVERLAY_WIDGET,
    MyoxusViewportOverlayWidget,
  );
}
