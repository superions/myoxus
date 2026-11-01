// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { AppSidebar } from "@myoxus/core/modules/app-sidebar/views";
import {
  GlobalDialogService,
  WorkspaceDialogService,
} from "@myoxus/core/modules/dialogs";
import { CMDKQuickSearchService } from "@myoxus/core/modules/quicksearch/services/cmdk";
import { AuthService, DefaultServerService } from "@myoxus/core/modules/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { type WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { ServerFeature } from "@myoxus/graphql";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  SidebarNavFooter,
  SidebarNavList,
  SidebarNavPinned,
  SidebarNavRoot,
  SidebarNavSection,
  SidebarNavSectionDivider,
} from "@myoxus/ui-facade";
import { memo, type ReactElement, type RefObject, useCallback } from "react";

import { StructureTreeOrganizeTree } from "../structure-tree";
import { LibrarySection } from "./library-section";
import {
  PrimaryNavigation,
  WorkspaceViewsNavigation,
} from "./primary-navigation";
import { SidebarAudioPlayer } from "./sidebar-audio-player";
import { TrashButton } from "./trash-button";
import { UpdaterButton } from "./updater-button";
import UserInfo from "./user-info";
import { WorkspaceMenu } from "./workspace-menu";
import { WorkspaceSidebarHeader } from "./workspace-sidebar-header";

/** Owns the complete left Workspace navigation composition. */
export const RootAppSidebar = memo((): ReactElement => {
  const { workbenchService, cMDKQuickSearchService, authService } = useServices(
    {
      WorkbenchService,
      CMDKQuickSearchService,
      AuthService,
    },
  );
  const sessionStatus = useLiveData(authService.session.status$);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const globalDialogService = useService(GlobalDialogService);
  const defaultServerService = useService(DefaultServerService);
  const workbench = workbenchService.workbench;
  const { jumpToPage } = useNavigateHelper();

  const openQuickSearch = useCallback(() => {
    cMDKQuickSearchService.toggle();
  }, [cMDKQuickSearchService]);

  const selectWorkspace = useCallback(
    (workspaceMetadata: WorkspaceMetadata) => {
      const closeInactiveViews = () =>
        workbench.views$.value.forEach((view) => {
          if (workbench.activeView$.value !== view) workbench.close(view);
        });

      if (document.startViewTransition) {
        document.startViewTransition(() => {
          closeInactiveViews();
          jumpToPage(workspaceMetadata.id, "home");
          return new Promise((resolve) => setTimeout(resolve, 150));
        });
      } else {
        closeInactiveViews();
        jumpToPage(workspaceMetadata.id, "home");
      }
    },
    [jumpToPage, workbench],
  );

  const openWorkspaceSettings = useCallback(() => {
    workspaceDialogService.open("workspace-settings", {
      activeTab: "workspace:preference",
    });
    track.$.navigationPanel.$.openSettings();
  }, [workspaceDialogService]);

  const newWorkspace = useCallback(
    (returnFocusRef: RefObject<HTMLElement | null>) => {
      const enableLocalWorkspace =
        canUseLocalWorkspaces() &&
        (BUILD_CONFIG.isNative ||
          defaultServerService.server.config$.value.features.includes(
            ServerFeature.LocalWorkspace,
          ));

      if (sessionStatus !== "authenticated" && !enableLocalWorkspace) {
        globalDialogService.open("sign-in", {});
        return;
      }

      track.$.navigationPanel.workspaceList.createWorkspace();
      globalDialogService.open(
        "create-workspace",
        { returnFocusRef },
        (payload) => {
          if (!payload) return;
          jumpToPage(payload.metadata.id, payload.defaultDocId ?? "home");
        },
      );
    },
    [defaultServerService, globalDialogService, jumpToPage, sessionStatus],
  );

  const addWorkspace = useCallback(() => {
    track.$.navigationPanel.workspaceList.createWorkspace({
      control: "import",
    });
    globalDialogService.open("import-workspace", undefined, (payload) => {
      if (payload) jumpToPage(payload.workspace.id, "home");
    });
  }, [globalDialogService, jumpToPage]);

  return (
    <AppSidebar
      header={
        <WorkspaceSidebarHeader
          onSearch={openQuickSearch}
          showNotifications={sessionStatus === "authenticated"}
        />
      }
    >
      <SidebarNavRoot>
        <SidebarNavPinned>
          <SidebarNavSection data-myoxus-ui-role="sidebar-workspace-section">
            <WorkspaceMenu
              onAddWorkspace={addWorkspace}
              onNewWorkspace={newWorkspace}
              onOpenWorkspaceSettings={openWorkspaceSettings}
              onSelectWorkspace={selectWorkspace}
            />
            <SidebarNavSectionDivider />
            <PrimaryNavigation />
          </SidebarNavSection>
        </SidebarNavPinned>
        <SidebarNavList>
          <WorkspaceViewsNavigation />
          <LibrarySection />
          <SidebarNavSection data-myoxus-ui-role="sidebar-folder-section">
            <StructureTreeOrganizeTree chrome="folders" />
          </SidebarNavSection>
        </SidebarNavList>
        <SidebarNavFooter>
          <SidebarNavSection>
            <TrashButton />
            <SidebarNavSectionDivider />
          </SidebarNavSection>
          <UserInfo />
          <SidebarAudioPlayer />
          {BUILD_CONFIG.isElectron ? <UpdaterButton /> : null}
        </SidebarNavFooter>
      </SidebarNavRoot>
    </AppSidebar>
  );
});

RootAppSidebar.displayName = "memo(RootAppSidebar)";
