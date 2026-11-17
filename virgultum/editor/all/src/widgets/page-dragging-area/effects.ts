import {
  MYOXUS_PAGE_DRAGGING_AREA_WIDGET,
  MyoxusPageDraggingAreaWidget,
} from "./index";

export function effects() {
  customElements.define(
    MYOXUS_PAGE_DRAGGING_AREA_WIDGET,
    MyoxusPageDraggingAreaWidget,
  );
}
