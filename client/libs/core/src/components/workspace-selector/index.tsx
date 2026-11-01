import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import {
  type WorkspaceMetadata,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useLiveData, useServiceOptional, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { useI18n } from "@myoxus/i18n";
import { Menu, type MenuProps, SidebarNavItem } from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";

import { UserWithWorkspaceList } from "./user-with-workspace-list";
import { WorkspaceCard } from "./workspace-card";

interface WorkspaceSelectorProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  workspaceMetadata?: WorkspaceMetadata;
  onSelectWorkspace?: (workspaceMetadata: WorkspaceMetadata) => void;
  onCreatedWorkspace?: (payload: {
    metadata: WorkspaceMetadata;
    defaultDocId?: string;
  }) => void;
  showEnableCloudButton?: boolean;
  showArrowDownIcon?: boolean;
  showSyncStatus?: boolean;
  disable?: boolean;
  menuContentOptions?: MenuProps["contentOptions"];
  className?: string;
  /** if true, will hide cloud/local, and scale the avatar */
  dense?: boolean;
}

export const WorkspaceSelector = ({
  workspaceMetadata: outerWorkspaceMetadata,
  onSelectWorkspace,
  onCreatedWorkspace,
  showArrowDownIcon,
  disable,
  open: outerOpen,
  onOpenChange: outerOnOpenChange,
  showEnableCloudButton,
  showSyncStatus,
  className,
  menuContentOptions,
  dense,
}: WorkspaceSelectorProps) => {
  const { workspacesService, globalContextService } = useServices({
    GlobalContextService,
    WorkspacesService,
  });
  const t = useI18n();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [innerOpen, setOpened] = useState(false);
  const open = outerOpen ?? innerOpen;
  const onOpenChange = useCallback(
    (open: boolean) => {
      outerOnOpenChange !== undefined
        ? outerOnOpenChange?.(open)
        : setOpened(open);
    },
    [outerOnOpenChange],
  );
  const closeUserWorkspaceList = useCallback(() => {
    if (outerOnOpenChange) {
      outerOnOpenChange(false);
    } else {
      setOpened(false);
    }
  }, [outerOnOpenChange]);
  const openUserWorkspaceList = useCallback(() => {
    track.$.navigationPanel.workspaceList.open();
    if (outerOnOpenChange) {
      outerOnOpenChange(true);
    } else {
      setOpened(true);
    }
  }, [outerOnOpenChange]);

  const currentWorkspaceId = useLiveData(
    globalContextService.globalContext.workspaceId.$,
  );
  const currentWorkspaceMetadata = useLiveData(
    currentWorkspaceId
      ? workspacesService.list.workspace$(currentWorkspaceId)
      : null,
  );
  const workspaceMetadata = outerWorkspaceMetadata ?? currentWorkspaceMetadata;

  // revalidate workspace list when open workspace list
  useEffect(() => {
    if (open) {
      workspacesService.list.revalidate();
    }
  }, [workspacesService, open]);

  return (
    <Menu
      rootOptions={{
        open,
        onOpenChange,
      }}
      items={
        <UserWithWorkspaceList
          returnFocusRef={triggerRef}
          onEventEnd={closeUserWorkspaceList}
          onClickWorkspace={onSelectWorkspace}
          onCreatedWorkspace={onCreatedWorkspace}
          showEnableCloudButton={showEnableCloudButton}
        />
      }
      contentOptions={{
        onInteractOutside: closeUserWorkspaceList,
        onEscapeKeyDown: closeUserWorkspaceList,
        panelWidth: "comfortable",
        ...menuContentOptions,
      }}
    >
      {workspaceMetadata ? (
        <WorkspaceCard
          ref={triggerRef}
          workspaceMetadata={workspaceMetadata}
          onClick={openUserWorkspaceList}
          showSyncStatus={showSyncStatus}
          className={className}
          showArrowDownIcon={showArrowDownIcon}
          disable={disable}
          hideCollaborationIcon={true}
          data-myoxus-ui-role="workspace-card"
          data-testid="current-workspace-card"
          dense={dense}
        />
      ) : (
        <SidebarNavItem ref={triggerRef} onClick={openUserWorkspaceList}>
          {t["com.myoxus.rootAppSidebar.workspaces"]()}
        </SidebarNavItem>
      )}
    </Menu>
  );
};

export const WorkspaceNavigator = ({
  onSelectWorkspace,
  onCreatedWorkspace,
  ...props
}: WorkspaceSelectorProps) => {
  const { jumpToPage } = useNavigateHelper();
  const workbench = useServiceOptional(WorkbenchService)?.workbench;

  const handleClickWorkspace = useCallback(
    (workspaceMetadata: WorkspaceMetadata) => {
      onSelectWorkspace?.(workspaceMetadata);

      const closeInactiveViews = () =>
        workbench?.views$.value.forEach((view) => {
          if (workbench?.activeView$.value !== view) {
            workbench?.close(view);
          }
        });

      if (document.startViewTransition) {
        document.startViewTransition(() => {
          closeInactiveViews();
          jumpToPage(workspaceMetadata.id, "home");
          return new Promise((resolve) =>
            setTimeout(resolve, 150),
          ); /* start transition after 150ms */
        });
      } else {
        closeInactiveViews();
        jumpToPage(workspaceMetadata.id, "home");
      }
    },
    [jumpToPage, onSelectWorkspace, workbench],
  );
  const handleCreatedWorkspace = useCallback(
    (payload: { metadata: WorkspaceMetadata; defaultDocId?: string }) => {
      onCreatedWorkspace?.(payload);
      if (document.startViewTransition) {
        document.startViewTransition(() => {
          if (payload.defaultDocId) {
            jumpToPage(payload.metadata.id, payload.defaultDocId);
          } else {
            jumpToPage(payload.metadata.id, "home");
          }
          return new Promise((resolve) =>
            setTimeout(resolve, 150),
          ); /* start transition after 150ms */
        });
      } else {
        if (payload.defaultDocId) {
          jumpToPage(payload.metadata.id, payload.defaultDocId);
        } else {
          jumpToPage(payload.metadata.id, "home");
        }
      }
    },
    [jumpToPage, onCreatedWorkspace],
  );
  return (
    <WorkspaceSelector
      onSelectWorkspace={handleClickWorkspace}
      onCreatedWorkspace={handleCreatedWorkspace}
      {...props}
    />
  );
};
