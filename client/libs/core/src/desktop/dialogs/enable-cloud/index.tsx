/**
 * `EnableCloudDialog` — migrates a local workspace to a selected server.
 *
 * Shows a server selector (`ServerSelector`) so the user can choose which
 * Myoxus-compatible server to sync with.  If the selected server requires
 * authentication and the user is not signed in, the dialog opens the
 * `sign-in` global dialog and waits for the result before proceeding.
 *
 * On success, the local workspace is migrated/linked to the cloud workspace
 * and the UI navigates to it.  On failure a toast notification is shown.
 */
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { ServerSelector } from "@myoxus/core/components/server-selector";
import {
  type DialogComponentProps,
  type GLOBAL_DIALOG_SCHEMA,
  GlobalDialogService,
} from "@myoxus/core/modules/dialogs";
import {
  AuthService,
  type Server,
  ServersService,
} from "@myoxus/core/modules/server";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import { ConfirmModal, notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

const Dialog = ({
  workspaceId,
  close,
  selectedServer,
  setSelectedServer,
  serverList,
  openPageId,
}: {
  workspaceId: string;
  serverList: Server[];
  selectedServer: Server;
  setSelectedServer: (server: Server) => void;
  openPageId?: string;
  serverId?: string;
  close?: () => void;
}) => {
  const t = useI18n();
  const authService = useService(AuthService);
  const account = useLiveData(authService.session.account$);
  const loginStatus = useLiveData(useService(AuthService).session.status$);
  const globalDialogService = useService(GlobalDialogService);
  const workspacesService = useService(WorkspacesService);
  const workspaceMeta = useLiveData(
    workspacesService.list.workspace$(workspaceId),
  );
  const { workspace } = workspaceMeta
    ? workspacesService.open({ metadata: workspaceMeta })
    : { workspace: undefined };

  const { jumpToPage } = useNavigateHelper();
  const [waitingForSignIn, setWaitingForSignIn] = useState(false);

  const enableCloud = useCallback(async () => {
    try {
      if (!workspace) return;
      if (!account) return;

      const { id: newId } = await workspacesService.transformLocalToCloud(
        workspace,
        account.id,
        selectedServer.id,
      );
      jumpToPage(newId, openPageId || "home");
      close?.();
    } catch (e) {
      console.error(e);
      notify.error({
        title: t["com.myoxus.workspace.enable-cloud.failed"](),
      });
    }
  }, [
    workspace,
    account,
    workspacesService,
    selectedServer.id,
    jumpToPage,
    openPageId,
    close,
    t,
  ]);

  const openSignIn = useCallback(() => {
    globalDialogService.open("sign-in", {
      server: selectedServer.baseUrl,
    });
  }, [globalDialogService, selectedServer.baseUrl]);

  const signInOrMigrate = useCallback(async () => {
    if (loginStatus === "unauthenticated") {
      setWaitingForSignIn(true);
      openSignIn();
      return;
    }
    if (loginStatus === "authenticated") {
      await enableCloud();
    }
  }, [enableCloud, loginStatus, openSignIn]);

  useEffect(() => {
    if (waitingForSignIn && loginStatus === "authenticated") {
      setWaitingForSignIn(false);
      void enableCloud();
    }
  }, [enableCloud, loginStatus, waitingForSignIn]);

  return (
    <ConfirmModal
      closeOnConfirm={false}
      confirmText={
        loginStatus === "authenticated"
          ? t["com.myoxus.workspaceMigration.custom-server.enable"]()
          : t["Sign in and Enable"]()
      }
      contentOptions={{ "data-testid": "workspace-migration-dialog" }}
      description={t["Enable Myoxus Cloud Description"]()}
      onConfirm={signInOrMigrate}
      onOpenChange={(open) => {
        if (!open) close?.();
      }}
      open
      title={t["com.myoxus.workspaceMigration.custom-server.title"]({
        workspaceName: workspace?.name$.value || t["Untitled"](),
      })}
    >
      <ServerSelector
        label={t["com.myoxus.workspaceMigration.custom-server.description"]()}
        onSelect={setSelectedServer}
        selectedServerId={selectedServer.id}
        servers={serverList}
      />
    </ConfirmModal>
  );
};

export const EnableCloudDialog = ({
  workspaceId,
  openPageId,
  serverId,
  close,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["enable-cloud"]>) => {
  const serversService = useService(ServersService);
  const serverList = useLiveData(serversService.servers$);
  const [selectedServerId, setSelectedServerId] = useState(serverId ?? "");
  const selectedServer =
    serverList.find(({ id }) => id === selectedServerId) ?? serverList[0];

  useEffect(() => {
    if (selectedServer && selectedServer.id !== selectedServerId) {
      setSelectedServerId(selectedServer.id);
    }
  }, [selectedServer, selectedServerId]);

  if (!selectedServer) {
    return null;
  }

  return (
    <FrameworkScope key={selectedServer.id} scope={selectedServer.scope}>
      <Dialog
        close={close}
        openPageId={openPageId}
        selectedServer={selectedServer}
        serverList={serverList}
        setSelectedServer={(server) => setSelectedServerId(server.id)}
        workspaceId={workspaceId}
      />
    </FrameworkScope>
  );
};
