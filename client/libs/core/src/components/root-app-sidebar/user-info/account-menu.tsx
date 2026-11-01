import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { useDownloadUrl } from "@myoxus/core/modules/open-in-app/get-download-url";
import { ServerService, UserFeatureService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import {
  AccountIcon,
  AdminIcon,
  DownloadIcon,
  SignOutIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { MenuItem, MenuSeparator } from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

import { useSignOut } from "../../hooks/myoxus/use-sign-out";

export const AccountMenu = () => {
  const workspaceDialogService = useService(WorkspaceDialogService);
  const openSignOutModal = useSignOut();
  const serverService = useService(ServerService);
  const userFeatureService = useService(UserFeatureService);
  const isMyoxusAdmin = useLiveData(userFeatureService.userFeature.isAdmin$);
  const downloadUrl = useDownloadUrl();

  const onOpenAccountSetting = useCallback(() => {
    track.$.navigationPanel.profileAndBadge.openSettings({ to: "account" });
    workspaceDialogService.open("user-settings", {
      activeTab: "account",
    });
  }, [workspaceDialogService]);

  const onOpenAdminPanel = useCallback(() => {
    window.open(`${serverService.server.baseUrl}/admin`, "_blank");
  }, [serverService.server.baseUrl]);

  const onDownloadApp = useCallback(() => {
    window.open(downloadUrl, "_blank");
  }, [downloadUrl]);

  const t = useI18n();

  useEffect(() => {
    userFeatureService.userFeature.revalidate();
  }, [userFeatureService]);

  return (
    <>
      <MenuItem
        prefixIcon={<AccountIcon />}
        data-testid="workspace-modal-account-settings-option"
        onClick={onOpenAccountSetting}
      >
        {t["com.myoxus.workspace.cloud.account.settings"]()}
      </MenuItem>
      <MenuItem prefixIcon={<DownloadIcon />} onClick={onDownloadApp}>
        {t["com.myoxus.other-page.nav.download-app"]()}
      </MenuItem>
      <MenuSeparator />
      {isMyoxusAdmin ? (
        <MenuItem
          prefixIcon={<AdminIcon />}
          data-testid="workspace-modal-account-admin-option"
          onClick={onOpenAdminPanel}
        >
          {t["com.myoxus.workspace.cloud.account.admin"]()}
        </MenuItem>
      ) : null}
      <MenuItem
        prefixIcon={<SignOutIcon />}
        data-testid="workspace-modal-sign-out-option"
        onClick={openSignOutModal}
      >
        {t["com.myoxus.workspace.cloud.account.logout"]()}
      </MenuItem>
    </>
  );
};
