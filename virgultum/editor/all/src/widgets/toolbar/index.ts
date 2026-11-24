import { WidgetViewExtension } from "@virgultum/core/runtime";

import { MYOXUS_TOOLBAR_WIDGET } from "./toolbar";

export * from "./toolbar";

export const toolbarWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_TOOLBAR_WIDGET,
  MYOXUS_TOOLBAR_WIDGET,
);
