import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { MenuItem } from "@myoxus/core/modules/app-sidebar/views";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { CollaborationIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { useCallback } from "react";

export const InviteMembersButton = ({
  onBeforeOpen,
}: {
  onBeforeOpen?: () => void;
}) => {
  const workspace = useService(WorkspaceService).workspace;
  const isLocal = workspace.flavour === "local";
  const canManageUsers = useGuard("Workspace_Users_Manage");

  const dialogService = useService(WorkspaceDialogService);
  const onOpenInviteMembersModal = useCallback(() => {
    onBeforeOpen?.();
    dialogService.open("workspace-settings", {
      activeTab: `workspace:members`,
    });
  }, [dialogService, onBeforeOpen]);

  const t = useI18n();

  if (isLocal || !canManageUsers) {
    return null;
  }

  return (
    <MenuItem
      data-testid="slider-bar-invite-members-button"
      icon={<CollaborationIcon />}
      onClick={onOpenInviteMembersModal}
    >
      {t["Invite Members"]()}
    </MenuItem>
  );
};
