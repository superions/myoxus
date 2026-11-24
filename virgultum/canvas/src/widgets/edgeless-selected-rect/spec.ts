import { WidgetViewExtension } from "@virgultum/core/runtime";

import { EDGELESS_SELECTED_RECT_WIDGET } from "./edgeless-selected-rect";

export const edgelessSelectedRectWidget = WidgetViewExtension(
  "myoxus:page",
  EDGELESS_SELECTED_RECT_WIDGET,
  EDGELESS_SELECTED_RECT_WIDGET,
);
