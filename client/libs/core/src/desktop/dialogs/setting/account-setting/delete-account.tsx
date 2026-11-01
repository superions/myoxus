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

export const DeleteAccount = () => {
  const t = useI18n();

  const serverService = useService(ServerService);
  const [showModal, setShowModal] = useState(false);
  const openModal = useCallback(() => {
    setShowModal(true);
  }, []);

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
        onClick={openModal}
        data-testid="delete-account-button"
      >
        <ArrowRightSmallIcon />
      </SettingRow>
      <DeleteAccountModal open={showModal} onOpenChange={setShowModal} />
    </SettingWrapper>
  );
};

const DeleteAccountModal = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const t = useI18n();
  const authService = useService(AuthService);
  const session = authService.session;
  const account = useLiveData(session.account$);
  const serverService = useService(ServerService);

  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleDeleteAccount = useCallback(async () => {
    try {
      setIsLoading(true);
      await authService.deleteAccount();
      track.$.$.auth.deleteAccount();
    } catch (err) {
      console.error(err);
      const error = UserFriendlyError.fromAny(err);
      notify.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [authService]);

  const onDeleteAccountConfirm = useCallback(async () => {
    await handleDeleteAccount();
  }, [handleDeleteAccount]);

  if (!account) {
    return null;
  }
  return (
    <ConfirmModal
      open={open}
      cancelText={t["com.myoxus.confirmModal.button.cancel"]()}
      onConfirm={onDeleteAccountConfirm}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.setting.account.delete.confirm-title"]()}
      description={
        <Trans
          i18nKey={
            "com.myoxus.setting.account.delete.confirm-delete-description-1"
          }
          components={{
            1: <strong />,
          }}
          values={{
            server:
              serverService.server.id !== "myoxus-cloud"
                ? `${serverService.server.config$.value.serverName} (${serverService.server.baseUrl})`
                : serverService.server.config$.value.serverName,
          }}
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
          components={{
            1: <strong />,
          }}
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
};
