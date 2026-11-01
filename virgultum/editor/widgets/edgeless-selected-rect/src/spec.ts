import { WidgetViewExtension } from "@virgultum/std";
import { literal, unsafeStatic } from "lit/static-html.js";

import { EDGELESS_SELECTED_RECT_WIDGET } from "./edgeless-selected-rect";

export const edgelessSelectedRectWidget = WidgetViewExtension(
  "myoxus:page",
  EDGELESS_SELECTED_RECT_WIDGET,
  literal`${unsafeStatic(EDGELESS_SELECTED_RECT_WIDGET)}`,
);
