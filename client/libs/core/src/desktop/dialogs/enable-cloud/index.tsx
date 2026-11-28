// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

function EnableCloudModalContent({
  workspaceId,
  close,
  selectedServer,
  onSelectServer,
  serverList,
  openPageId,
}: {
  workspaceId: string;
  serverList: Server[];
  selectedServer: Server;
  onSelectServer: (server: Server) => void;
  openPageId?: string;
  close?: () => void;
}) {
  const t = useI18n();
  const authService = useService(AuthService);
  const account = useLiveData(authService.session.account$);
  const loginStatus = useLiveData(authService.session.status$);
  const globalDialogService = useService(GlobalDialogService);
  const workspacesService = useService(WorkspacesService);
  const workspaceMeta = useLiveData(
    workspacesService.list.workspace$(workspaceId),
  );
  const workspace = workspaceMeta
    ? workspacesService.open({ metadata: workspaceMeta }).workspace
    : undefined;

  const { jumpToPage } = useNavigateHelper();
  const [waitingForSignIn, setWaitingForSignIn] = useState(false);

  const migrateWorkspace = useCallback(async () => {
    if (!workspace || !account) return;
    try {
      const { id: newId } = await workspacesService.transformLocalToCloud(
        workspace,
        account.id,
        selectedServer.id,
      );
      jumpToPage(newId, openPageId || "home");
      close?.();
    } catch (error) {
      console.error(error);
      notify.error({
        title: t["com.myoxus.workspace.enable-cloud.failed"](),
      });
    }
  }, [
    account,
    close,
    jumpToPage,
    openPageId,
    selectedServer.id,
    t,
    workspace,
    workspacesService,
  ]);

  const handleConfirm = useCallback(async () => {
    if (loginStatus === "unauthenticated") {
      setWaitingForSignIn(true);
      globalDialogService.open("sign-in", { server: selectedServer.baseUrl });
      return;
    }
    if (loginStatus === "authenticated") {
      await migrateWorkspace();
    }
  }, [
    globalDialogService,
    loginStatus,
    migrateWorkspace,
    selectedServer.baseUrl,
  ]);

  useEffect(() => {
    if (waitingForSignIn && loginStatus === "authenticated") {
      setWaitingForSignIn(false);
      void migrateWorkspace();
    }
  }, [loginStatus, migrateWorkspace, waitingForSignIn]);

  return (
    <ConfirmModal
      open
      closeOnConfirm={false}
      confirmText={
        loginStatus === "authenticated"
          ? t["com.myoxus.workspaceMigration.custom-server.enable"]()
          : t["Sign in and Enable"]()
      }
      contentOptions={{ "data-testid": "workspace-migration-dialog" }}
      description={t["Enable Myoxus Cloud Description"]()}
      onConfirm={handleConfirm}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close?.();
      }}
      title={t["com.myoxus.workspaceMigration.custom-server.title"]({
        workspaceName: workspace?.name$.value || t["Untitled"](),
      })}
    >
      <ServerSelector
        label={t["com.myoxus.workspaceMigration.custom-server.description"]()}
        onSelect={onSelectServer}
        selectedServerId={selectedServer.id}
        servers={serverList}
      />
    </ConfirmModal>
  );
}

/**
 * Migrates an Electron local workspace onto a selected Myoxus server.
 */
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
      <EnableCloudModalContent
        close={close}
        openPageId={openPageId}
        selectedServer={selectedServer}
        serverList={serverList}
        onSelectServer={(server) => setSelectedServerId(server.id)}
        workspaceId={workspaceId}
      />
    </FrameworkScope>
  );
};
