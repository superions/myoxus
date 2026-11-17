import { WidgetViewExtension } from "@virgultum/core/runtime";
import { literal, unsafeStatic } from "lit/static-html.js";

import { MYOXUS_SCROLL_ANCHORING_WIDGET } from "./scroll-anchoring.js";

export * from "./scroll-anchoring.js";

export const scrollAnchoringWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_SCROLL_ANCHORING_WIDGET,
  literal`${unsafeStatic(MYOXUS_SCROLL_ANCHORING_WIDGET)}`,
);
