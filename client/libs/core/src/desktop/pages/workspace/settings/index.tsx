/**
 * Settings redirect — the `/settings` workbench route.
 *
 * This component renders nothing visible.  Its sole purpose is to open the
 * workspace settings dialog when the route is navigated to directly (e.g. from
 * a notification deep-link or programmatic navigation).
 *
 * ### Behaviour
 * 1. Calls `workbench.openAll()` to maximise the workbench from any split-view
 *    state before the modal appears.
 * 2. Opens the settings dialog via `WorkspaceDialogService`, optionally
 *    pre-selecting a tab via the `?tab=<SettingTab>` query parameter.
 * 3. The `isOpened` ref prevents the dialog from being opened twice in React
 *    StrictMode (which double-invokes effects in development).
 *
 * After the dialog opens the router continues to hold this route in the URL,
 * so closing the modal will leave the user on the settings URL.  Navigation
 * back or to a different route is expected to be handled by the dialog itself.
 */
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import type {
  UserSettingTab,
  WorkspaceSettingTab,
} from "@myoxus/core/modules/dialogs/constant";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useService } from "@myoxus/infra";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

export const Component = () => {
  const workbenchService = useService(WorkbenchService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const workbench = workbenchService.workbench;

  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? undefined;

  const isOpened = useRef(false);

  useEffect(() => {
    if (isOpened.current) {
      return;
    }
    isOpened.current = true; // prevent open multiple times
    workbench.openAll();
    if (tab?.startsWith("workspace:")) {
      workspaceDialogService.open("workspace-settings", {
        activeTab: tab as WorkspaceSettingTab,
      });
    } else {
      workspaceDialogService.open("user-settings", {
        activeTab: tab as UserSettingTab | undefined,
      });
    }
  }, [tab, workbench, workspaceDialogService]);
  return null;
};
