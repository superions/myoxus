// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type DialogComponentProps,
  type GLOBAL_DIALOG_SCHEMA,
  GlobalDialogService,
} from "@myoxus/core/modules/dialogs";
import { AuthService, ServersService } from "@myoxus/core/modules/server";
import type { WorkspaceMetadata } from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { Button, ConfirmModal, Input, Stack } from "@myoxus/ui-facade";
import { type ComponentProps, useState } from "react";

import { CloudWorkspaceDialog } from "./cloud-dialog";
import { LocalWorkspaceDialog } from "./local-dialog";
import { ServerSelector } from "./server-selector";

/**
 * Coordinates workspace creation across local (Electron) and authenticated
 * cloud targets while preserving the draft name across sign-in handoff.
 */
export const CreateWorkspaceDialog = ({
  serverId,
  close,
  ...props
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["create-workspace"]>) => {
  const t = useI18n();
  const serversService = useService(ServersService);
  const dialogs = useService(GlobalDialogService);

  const [name, setName] = useState("");
  const [open, setOpen] = useState(true);
  const [nameChecked, setNameChecked] = useState(false);
  const [targetId, setTargetId] = useState(() => {
    if (serverId === "local" && !canUseLocalWorkspaces()) {
      return serversService.selectedServerId$.value ?? "";
    }
    return (
      serverId ??
      serversService.selectedServerId$.value ??
      (canUseLocalWorkspaces() ? "local" : "")
    );
  });

  const servers = useLiveData(serversService.servers$);
  const server = useLiveData(
    targetId && targetId !== "local" ? serversService.server$(targetId) : null,
  );
  const account = useLiveData(
    server?.scope.get(AuthService).session.account$ ?? null,
  );

  const showTargetSelector =
    servers.length + (canUseLocalWorkspaces() ? 1 : 0) > 1;

  const renderTarget = (disabled: boolean) =>
    showTargetSelector ? (
      <ServerSelector
        label={t["com.myoxus.nameWorkspace.subtitle.workspace-type"]()}
        selectedId={targetId}
        onChange={setTargetId}
        disabled={disabled}
      />
    ) : null;

  const modal: ComponentProps<typeof ConfirmModal> = {
    ...props,
    open,
    onOpenChange: setOpen,
    onExitTransitionEnd: () => {
      if (!open) close();
    },
    title: t["com.myoxus.nameWorkspace.title"](),
    cancelText: t.Cancel(),
    closeButtonOptions: { "data-testid": "create-workspace-close-button" },
  };

  const handleCreated = (metadata: WorkspaceMetadata) => close({ metadata });

  if (targetId === "local" && canUseLocalWorkspaces()) {
    return (
      <LocalWorkspaceDialog
        modal={modal}
        name={name}
        onNameChange={setName}
        target={renderTarget}
        onCreated={handleCreated}
      />
    );
  }

  if (server && account) {
    return (
      <CloudWorkspaceDialog
        key={JSON.stringify([server.id, account.id])}
        modal={modal}
        server={server}
        actorId={account.id}
        name={name}
        onNameChange={setName}
        target={renderTarget}
        onCreated={handleCreated}
      />
    );
  }

  return (
    <ConfirmModal
      {...modal}
      customConfirmButton={() => (
        <Button
          type="submit"
          form="create-workspace-sign-in-form"
          variant="primary"
          data-testid="create-workspace-create-button"
          disabled={!server}
        >
          {t.Create()}
        </Button>
      )}
    >
      <form
        id="create-workspace-sign-in-form"
        onSubmit={(event) => {
          event.preventDefault();
          setNameChecked(true);
          if (server && name.trim()) {
            dialogs.open("sign-in", { server: server.baseUrl });
          }
        }}
      >
        <Stack>
          <Input
            autoFocus
            data-autofocus
            required
            value={name}
            onChange={setName}
            error={
              nameChecked && !name.trim()
                ? t["com.myoxus.document-metadata.validation.required"]({
                    label:
                      t["com.myoxus.nameWorkspace.subtitle.workspace-name"](),
                  })
                : undefined
            }
            maxLength={64}
            label={t["com.myoxus.nameWorkspace.subtitle.workspace-name"]()}
            data-testid="create-workspace-input"
          />
          {renderTarget(false)}
        </Stack>
      </form>
    </ConfirmModal>
  );
};
