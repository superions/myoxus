import { WidgetViewExtension } from "@virgultum/std";
import { literal, unsafeStatic } from "lit/static-html.js";

import { MYOXUS_DOC_REMOTE_SELECTION_WIDGET } from "./doc";
import { MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET } from "./edgeless";

export * from "./doc";
export * from "./edgeless";

export const docRemoteSelectionWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_DOC_REMOTE_SELECTION_WIDGET,
  literal`${unsafeStatic(MYOXUS_DOC_REMOTE_SELECTION_WIDGET)}`,
);

export const edgelessRemoteSelectionWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET,
  literal`${unsafeStatic(MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET)}`,
);
