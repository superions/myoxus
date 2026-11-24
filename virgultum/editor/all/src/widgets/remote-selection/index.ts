import { WidgetViewExtension } from "@virgultum/core/runtime";

import { MYOXUS_DOC_REMOTE_SELECTION_WIDGET } from "./doc";
import { MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET } from "./edgeless";

export * from "./doc";
export * from "./edgeless";

export const docRemoteSelectionWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_DOC_REMOTE_SELECTION_WIDGET,
  MYOXUS_DOC_REMOTE_SELECTION_WIDGET,
);

export const edgelessRemoteSelectionWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET,
  MYOXUS_EDGELESS_REMOTE_SELECTION_WIDGET,
);
