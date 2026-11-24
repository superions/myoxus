import { WidgetViewExtension } from "@virgultum/core/runtime";

import { MYOXUS_SCROLL_ANCHORING_WIDGET } from "./scroll-anchoring.js";

export * from "./scroll-anchoring.js";

export const scrollAnchoringWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_SCROLL_ANCHORING_WIDGET,
  MYOXUS_SCROLL_ANCHORING_WIDGET,
);
