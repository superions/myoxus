// SPDX-License-Identifier: MIT

import { useI18n } from "@myoxus/i18n";
import { SidebarIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { ShellSidebarToggle } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { AppSidebarService } from "../services/app-sidebar";

export const AppSidebarToggle = () => {
  const t = useI18n();
  const appSidebarService = useService(AppSidebarService).sidebar;
  const open = useLiveData(appSidebarService.open$);

  const handleToggle = useCallback(() => {
    track.$.navigationPanel.$.toggle({
      type: open ? "collapse" : "expand",
    });
    appSidebarService.toggleSidebar();
  }, [appSidebarService, open]);

  return (
    <ShellSidebarToggle
      collapsed={!open}
      aria-label={
        open
          ? t["com.myoxus.sidebarSwitch.collapse"]()
          : t["com.myoxus.sidebarSwitch.expand"]()
      }
      data-myoxus-ui-role="button:icon-only:app-sidebar-collapse"
      data-testid="app-sidebar-collapse-button"
      onClick={handleToggle}
    >
      <SidebarIcon data-myoxus-ui-role="app-sidebar-collapse-icon" />
    </ShellSidebarToggle>
  );
};
