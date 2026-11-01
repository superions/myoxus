import { NotificationList } from "@myoxus/core/components/notification/list";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { NotificationCountService } from "@myoxus/core/modules/notification";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { NotificationIcon, SettingsIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  CountIndicator,
  IconButton,
  Menu,
  MobileHomeHeaderActions,
  MobileHomeHeaderContent,
  MobileHomeHeaderFloatingBar,
  MobileHomeHeaderFloatingWorkspaceSlot,
  MobileHomeHeaderRoot,
  MobileHomeHeaderSpacer,
  startScopedViewTransition,
} from "@myoxus/ui-facade";
import { useCallback, useRef, useState } from "react";

import {
  SearchInput,
  searchVTScope,
  WorkspaceSelector,
} from "../../components";
import { useGlobalEvent } from "../../hooks/use-global-events";

/**
 * Contains `Setting`, `Workspace Selector`, `Search`
 * When scrolled:
 *   - combine Setting and Workspace Selector
 *   - hide Search
 */
export const HomeHeader = () => {
  const workspaceDialogService = useService(WorkspaceDialogService);

  const workspaceCardRef = useRef<HTMLElement>(null);
  const floatWorkspaceCardRef = useRef<HTMLElement>(null);
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const notificationCountService = useService(NotificationCountService);
  const notificationCount = useLiveData(notificationCountService.count$);

  const navSearch = useCallback(() => {
    startScopedViewTransition(searchVTScope, () => {
      workbench.open("/search");
    });
  }, [workbench]);

  const [dense, setDense] = useState(false);

  useGlobalEvent(
    "scroll",
    useCallback(() => {
      if (!workspaceCardRef.current || !floatWorkspaceCardRef.current) return;
      const inFlowTop = workspaceCardRef.current.getBoundingClientRect().top;
      const floatTop =
        floatWorkspaceCardRef.current.getBoundingClientRect().top;
      setDense(inFlowTop <= floatTop);
    }, []),
  );

  const openSetting = useCallback(() => {
    workspaceDialogService.open("user-settings", {
      activeTab: "appearance",
    });
  }, [workspaceDialogService]);

  return (
    <>
      <MobileHomeHeaderRoot>
        <MobileHomeHeaderSpacer />
        <MobileHomeHeaderContent>
          <WorkspaceSelector ref={workspaceCardRef} />
          <SearchInput placeholder={t["Quick search"]()} onClick={navSearch} />
        </MobileHomeHeaderContent>
      </MobileHomeHeaderRoot>
      {/* float */}
      <MobileHomeHeaderRoot fixed dense={dense}>
        <MobileHomeHeaderFloatingBar>
          <MobileHomeHeaderFloatingWorkspaceSlot dense={dense}>
            <WorkspaceSelector ref={floatWorkspaceCardRef} />
          </MobileHomeHeaderFloatingWorkspaceSlot>
          <MobileHomeHeaderActions>
            <CountIndicator count={notificationCount}>
              <Menu items={<NotificationList />}>
                <IconButton
                  aria-label="Notifications"
                  icon={<NotificationIcon />}
                  data-myoxus-ui-role="button:mobile-home-notifications"
                />
              </Menu>
            </CountIndicator>
            <IconButton
              aria-label="Settings"
              onClick={openSetting}
              icon={<SettingsIcon />}
              data-testid="settings-button"
              data-myoxus-ui-role="button:mobile-home-settings"
            />
          </MobileHomeHeaderActions>
        </MobileHomeHeaderFloatingBar>
      </MobileHomeHeaderRoot>
    </>
  );
};
