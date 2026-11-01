// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MenuItem } from "@myoxus/core/modules/app-sidebar/views";
import {
  type WorkspaceMetadata,
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  CloudWorkspaceIcon,
  MoreVerticalIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { Menu, MenuScrollableSection, SidebarNavItem } from "@myoxus/ui-facade";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { AddWorkspace } from "../workspace-selector/user-with-workspace-list/add-workspace";
import { MyoxusWorkspaceList } from "../workspace-selector/user-with-workspace-list/workspace-list";
import { PureWorkspaceCard } from "../workspace-selector/workspace-card";
import { InviteMembersButton } from "./invite-members-button";

function workspaceDisplayName(workspace: WorkspaceMetadata) {
  return workspace.name?.trim() || workspace.id;
}

function workspaceSortRank(workspace: WorkspaceMetadata) {
  const workspaceType = workspace.workspaceType ?? "Personal";
  return workspaceType === "Personal" ? 0 : 1;
}

export function sortWorkspaceNavigationItems(workspaces: WorkspaceMetadata[]) {
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });

  return [...workspaces].sort((a, b) => {
    const rank = workspaceSortRank(a) - workspaceSortRank(b);
    return (
      rank ||
      collator.compare(workspaceDisplayName(a), workspaceDisplayName(b)) ||
      a.id.localeCompare(b.id)
    );
  });
}

function WorkspaceList({
  onSelectWorkspace,
}: {
  onSelectWorkspace: (workspace: WorkspaceMetadata) => void;
}) {
  const workspacesService = useService(WorkspacesService);
  const currentWorkspace = useService(WorkspaceService).workspace;
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const sortedWorkspaces = useMemo(
    () => sortWorkspaceNavigationItems(workspaces),
    [workspaces],
  );

  return sortedWorkspaces.map((workspace) => (
    <PureWorkspaceCard
      key={workspace.id}
      active={currentWorkspace.id === workspace.id}
      data-testid={
        currentWorkspace.id === workspace.id
          ? "sidebar-current-workspace"
          : `sidebar-workspace-${workspace.id}`
      }
      onClick={() => onSelectWorkspace(workspace)}
      workspaceMetadata={workspace}
    />
  ));
}

export function WorkspaceMenu({
  onAddWorkspace,
  onNewWorkspace,
  onOpenWorkspaceSettings,
  onSelectWorkspace,
}: {
  onAddWorkspace: () => void;
  onNewWorkspace: (returnFocusRef: RefObject<HTMLElement | null>) => void;
  onOpenWorkspaceSettings: () => void;
  onSelectWorkspace: (workspace: WorkspaceMetadata) => void;
}) {
  const t = useI18n();
  const currentWorkspace = useService(WorkspaceService).workspace;
  const currentWorkspaceName = useLiveData(currentWorkspace.name$);
  const workspacesService = useService(WorkspacesService);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) workspacesService.list.revalidate();
  }, [open, workspacesService]);

  const closeMenu = () => setOpen(false);

  return (
    <Menu
      rootOptions={{ open, onOpenChange: setOpen }}
      contentOptions={{ panelWidth: "wide", side: "right", align: "start" }}
      items={
        <>
          {/* Native must retain the existing per-server account, connection and
              removal controls. Web keeps its single-origin workspace menu. */}
          <MenuScrollableSection maxHeight="default">
            {BUILD_CONFIG.isNative ? (
              <MyoxusWorkspaceList
                onClickWorkspace={onSelectWorkspace}
                onEventEnd={closeMenu}
              />
            ) : (
              <WorkspaceList
                onSelectWorkspace={(workspace) => {
                  closeMenu();
                  onSelectWorkspace(workspace);
                }}
              />
            )}
          </MenuScrollableSection>
          <AddWorkspace
            onAddWorkspace={() => {
              closeMenu();
              onAddWorkspace();
            }}
            onNewWorkspace={() => {
              closeMenu();
              onNewWorkspace(triggerRef);
            }}
          />
          <InviteMembersButton onBeforeOpen={closeMenu} />
          <MenuItem
            icon={<SettingsIcon />}
            onClick={() => {
              closeMenu();
              onOpenWorkspaceSettings();
            }}
            data-testid="workspace-navigation-settings"
          >
            {t["com.myoxus.settings.workspace.preferences"]()}
          </MenuItem>
        </>
      }
    >
      <SidebarNavItem
        ref={triggerRef}
        data-testid="sidebar-workspaces-section"
        data-myoxus-ui-role="sidebar-workspace-row"
        leading={<CloudWorkspaceIcon />}
        actions={<MoreVerticalIcon />}
      >
        {currentWorkspaceName ||
          currentWorkspace.meta.name ||
          t["com.myoxus.rootAppSidebar.workspaces"]()}
      </SidebarNavItem>
    </Menu>
  );
}
