import { EDGELESS_SELECTED_RECT_WIDGET } from "./edgeless-selected-rect";
import { EdgelessSelectedRectWidget } from "./native-selection-overlay";

export function effects() {
  customElements.define(
    EDGELESS_SELECTED_RECT_WIDGET,
    EdgelessSelectedRectWidget,
  );
}
