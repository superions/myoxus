// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import {
  RouteLogic,
  useNavigateHelper,
} from "@myoxus/core/components/hooks/use-navigate-helper";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { WorkspacePermissionService } from "@myoxus/core/modules/permissions";
import {
  WorkspaceService,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { useCallback, useEffect, useState } from "react";

import {
  ConfirmModal,
  MyoxusText,
  notify,
  SettingRow,
} from "../../../primitives";
import { WorkspaceDeleteModal } from "./delete";

export const DeleteLeaveWorkspace = ({
  onCloseSetting,
}: {
  onCloseSetting?: () => void;
}) => {
  const {
    workspaceService,
    globalContextService,
    workspacePermissionService,
    workspacesService,
  } = useServices({
    WorkspaceService,
    GlobalContextService,
    WorkspacePermissionService,
    WorkspacesService,
  });
  const t = useI18n();
  const workspace = workspaceService.workspace;
  const { jumpToPage, jumpToIndex } = useNavigateHelper();

  const [showDelete, setShowDelete] = useState(false);
  const [showLeave, setShowLeave] = useState(false);

  const workspaceList = useLiveData(workspacesService.list.workspaces$);
  const currentWorkspaceId = useLiveData(
    globalContextService.globalContext.workspaceId.$,
  );
  const isOwner = useLiveData(workspacePermissionService.permission.isOwner$);

  useEffect(() => {
    workspacePermissionService.permission.revalidate();
  }, [workspacePermissionService]);

  const handleOpenConfirm = useCallback(() => {
    if (isOwner === null) return;
    if (isOwner) setShowDelete(true);
    else setShowLeave(true);
  }, [isOwner]);

  const handleConfirm = useAsyncCallback(async () => {
    onCloseSetting?.();

    if (currentWorkspaceId === workspace.id) {
      const fallbackWorkspace = workspaceList.find(
        (candidate) => candidate.id !== currentWorkspaceId,
      );
      if (fallbackWorkspace) {
        jumpToPage(fallbackWorkspace.id, "home", RouteLogic.REPLACE);
      } else {
        jumpToIndex(RouteLogic.REPLACE);
      }
    }

    if (isOwner) {
      await workspacesService.deleteWorkspace(workspace.meta);
    } else {
      await workspacePermissionService.leaveWorkspace();
    }
    notify.success({ title: t["Successfully deleted"]() });
  }, [
    currentWorkspaceId,
    isOwner,
    jumpToIndex,
    jumpToPage,
    onCloseSetting,
    t,
    workspace.id,
    workspace.meta,
    workspaceList,
    workspacePermissionService,
    workspacesService,
  ]);

  return (
    <>
      <SettingRow
        name={
          <MyoxusText
            component="span"
            tone="danger"
            typographySlot="body-small"
            data-myoxus-ui-role="workspace-preference-danger-action-label"
          >
            {isOwner
              ? t["com.myoxus.workspaceDelete.title"]()
              : t["com.myoxus.deleteLeaveWorkspace.leave"]()}
          </MyoxusText>
        }
        desc={t["com.myoxus.deleteLeaveWorkspace.description"]()}
        onClick={handleOpenConfirm}
        data-testid="delete-workspace-button"
      >
        <ArrowRightSmallIcon />
      </SettingRow>
      {isOwner ? (
        <WorkspaceDeleteModal
          onConfirm={handleConfirm}
          open={showDelete}
          onOpenChange={setShowDelete}
          workspaceMetadata={workspace.meta}
        />
      ) : (
        <ConfirmModal
          open={showLeave}
          cancelText={t["com.myoxus.confirmModal.button.cancel"]()}
          onConfirm={handleConfirm}
          onOpenChange={setShowLeave}
          title={`${t["com.myoxus.deleteLeaveWorkspace.leave"]()}?`}
          description={t["com.myoxus.deleteLeaveWorkspace.leaveDescription"]()}
          confirmText={t["Leave"]()}
          confirmButtonOptions={{ variant: "error" }}
        />
      )}
    </>
  );
};
