import { WidgetViewExtension } from "@virgultum/core/runtime";

import { MYOXUS_DRAG_HANDLE_WIDGET } from "./consts";

export * from "./consts";
export * from "./drag-handle";
export * from "./utils";
export type { DragBlockPayload } from "./watchers/drag-event-watcher";

export const dragHandleWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_DRAG_HANDLE_WIDGET,
  MYOXUS_DRAG_HANDLE_WIDGET,
);
