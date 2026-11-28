// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { AuthService, ServerService } from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import { Trans, useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { useCallback, useState } from "react";

import {
  ConfirmModal,
  Input,
  MyoxusText,
  notify,
  SettingRow,
  SettingsInlineControl,
  SettingWrapper,
  Stack,
} from "../primitives";

function DeleteAccountModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useI18n();
  const authService = useService(AuthService);
  const serverService = useService(ServerService);
  const account = useLiveData(authService.session.account$);

  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleConfirmDelete = useCallback(async () => {
    setIsLoading(true);
    try {
      await authService.deleteAccount();
      track.$.$.auth.deleteAccount();
    } catch (error) {
      console.error(error);
      notify.error(UserFriendlyError.fromAny(error));
    } finally {
      setIsLoading(false);
    }
  }, [authService]);

  if (!account) return null;

  const serverLabel =
    serverService.server.id !== "myoxus-cloud"
      ? `${serverService.server.config$.value.serverName} (${serverService.server.baseUrl})`
      : serverService.server.config$.value.serverName;

  return (
    <ConfirmModal
      open={open}
      cancelText={t["com.myoxus.confirmModal.button.cancel"]()}
      onConfirm={handleConfirmDelete}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.setting.account.delete.confirm-title"]()}
      description={
        <Trans
          i18nKey="com.myoxus.setting.account.delete.confirm-delete-description-1"
          components={{ 1: <strong /> }}
          values={{ server: serverLabel }}
        />
      }
      confirmText={t["com.myoxus.setting.account.delete.confirm-button"]()}
      confirmButtonOptions={{
        variant: "error",
        disabled: email !== account.email,
        loading: isLoading,
      }}
    >
      <Stack>
        <Trans
          i18nKey="com.myoxus.setting.account.delete.confirm-delete-description-2"
          components={{ 1: <strong /> }}
        />
        <SettingsInlineControl data-myoxus-ui-role="account-delete-modal-input-control">
          <Input
            block
            type="text"
            placeholder={t[
              "com.myoxus.setting.account.delete.input-placeholder"
            ]()}
            value={email}
            onChange={setEmail}
          />
        </SettingsInlineControl>
      </Stack>
    </ConfirmModal>
  );
}

export const DeleteAccount = () => {
  const t = useI18n();
  const serverService = useService(ServerService);
  const [showModal, setShowModal] = useState(false);

  return (
    <SettingWrapper>
      <SettingRow
        name={
          <MyoxusText component="span" tone="danger">
            {t["com.myoxus.setting.account.delete-from-server"]({
              server: serverService.server.config$.value.serverName,
            })}
          </MyoxusText>
        }
        desc={t["com.myoxus.setting.account.delete.message"]()}
        onClick={() => setShowModal(true)}
        data-testid="delete-account-button"
      >
        <ArrowRightSmallIcon />
      </SettingRow>
      <DeleteAccountModal open={showModal} onOpenChange={setShowModal} />
    </SettingWrapper>
  );
};
