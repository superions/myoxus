import { WidgetViewExtension } from "@virgultum/std";
import { literal, unsafeStatic } from "lit/static-html.js";

import { MYOXUS_TOOLBAR_WIDGET } from "./toolbar";

export * from "./toolbar";

export const toolbarWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_TOOLBAR_WIDGET,
  literal`${unsafeStatic(MYOXUS_TOOLBAR_WIDGET)}`,
);
