/**
 * DocumentTitle — headless component that keeps `document.title` in sync with
 * the active workbench view.
 *
 * Renders nothing to the DOM. Uses a `useEffect` to update `document.title`
 * whenever the active view's title or the unread notification count changes.
 *
 * Title format:
 * - With unread notifications: `"(N) <ViewTitle> · Myoxus"`
 * - Without notifications: `"<ViewTitle> · Myoxus"`
 * - No active view title: `"Myoxus"`
 *
 * Resets to `"Myoxus"` on unmount.
 */
import { NotificationCountService } from "@myoxus/core/modules/notification";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect } from "react";

/**
 * Synchronises `document.title` with the active workbench view and
 * notification count.
 *
 * This component must be mounted inside a `FrameworkScope` that provides both
 * `WorkbenchService` and `NotificationCountService`.
 */
export const DocumentTitle = () => {
  const notificationCountService = useService(NotificationCountService);
  const notificationCount = useLiveData(notificationCountService.count$);
  const workbenchService = useService(WorkbenchService);
  const workbenchView = useLiveData(workbenchService.workbench.activeView$);
  const viewTitle = useLiveData(workbenchView.title$);

  useEffect(() => {
    const prefix = notificationCount > 0 ? `(${notificationCount}) ` : "";
    document.title = prefix + (viewTitle ? `${viewTitle} · Myoxus` : "Myoxus");

    return () => {
      document.title = "Myoxus";
    };
  }, [notificationCount, viewTitle]);

  return null;
};
