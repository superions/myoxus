import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { AuthService, ServersService } from "@myoxus/core/modules/server";
import {
  type Workspace,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { notify, useConfirmModal } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { useNavigateHelper } from "../use-navigate-helper";

interface ConfirmEnableCloudOptions {
  /**
   * Fired when the workspace is successfully enabled
   */
  onSuccess?: () => void;
  /**
   * Fired when workspace is successfully enabled or user cancels the operation
   */
  onFinished?: () => void;
  openPageId?: string;
  serverId?: string;
}
type ConfirmEnableArgs = [Workspace, ConfirmEnableCloudOptions | undefined];

export const useEnableServer = () => {
  const t = useI18n();
  const authService = useService(AuthService);
  const account = useLiveData(authService.session.account$);
  const loginStatus = useLiveData(useService(AuthService).session.status$);
  const globalDialogService = useService(GlobalDialogService);
  const { openConfirmModal, closeConfirmModal } = useConfirmModal();
  const workspacesService = useService(WorkspacesService);
  const serversService = useService(ServersService);
  const serverList = useLiveData(serversService.servers$);

  const { jumpToPage } = useNavigateHelper();

  const enableCloud = useCallback(
    async (ws: Workspace | null, options?: ConfirmEnableCloudOptions) => {
      try {
        if (!ws) return;
        if (!account) return;
        const serverId = options?.serverId ?? serverList[0]?.id;
        if (!serverId) return;
        const { id: newId } = await workspacesService.transformLocalToCloud(
          ws,
          account.id,
          serverId,
        );
        jumpToPage(newId, options?.openPageId || "home");
        options?.onSuccess?.();
      } catch (e) {
        console.error(e);
        notify.error({
          title: t["com.myoxus.workspace.enable-cloud.failed"](),
        });
      }
    },
    [account, jumpToPage, serverList, t, workspacesService],
  );

  const openSignIn = useCallback(
    () =>
      globalDialogService.open("sign-in", {
        step: "signIn",
      }),
    [globalDialogService],
  );

  const signInOrEnableCloud = useCallback(
    async (...args: ConfirmEnableArgs) => {
      // not logged in, open login modal
      if (loginStatus === "unauthenticated") {
        openSignIn();
      }

      if (loginStatus === "authenticated") {
        await enableCloud(...args);
      }
    },
    [enableCloud, loginStatus, openSignIn],
  );

  const migrateWorkspaceToServer = useCallback(
    (ws: Workspace, options?: ConfirmEnableCloudOptions) => {
      const { onSuccess, onFinished, serverId, openPageId } = options ?? {};

      const closeOnSuccess = () => {
        closeConfirmModal();
        onSuccess?.();
      };

      if (serverList.length > 1) {
        globalDialogService.open("enable-cloud", {
          workspaceId: ws.id,
          serverId,
          openPageId,
        });
        return;
      }

      openConfirmModal(
        {
          title: t["Enable Myoxus Cloud"](),
          description: t["Enable Myoxus Cloud Description"](),
          cancelText: t["Cancel"](),
          confirmText:
            loginStatus === "authenticated"
              ? t["Enable"]()
              : t["Sign in and Enable"](),
          confirmButtonOptions: {
            variant: "primary",
            ["data-testid" as string]: "confirm-enable-myoxus-cloud-button",
          },
          onConfirm: async () =>
            await signInOrEnableCloud(ws, {
              ...options,
              onSuccess: closeOnSuccess,
            }),
          onOpenChange: (open) => {
            if (!open) onFinished?.();
          },
        },
        {
          autoClose: false,
        },
      );
    },
    [
      closeConfirmModal,
      globalDialogService,
      loginStatus,
      openConfirmModal,
      serverList.length,
      signInOrEnableCloud,
      t,
    ],
  );

  return migrateWorkspaceToServer;
};
