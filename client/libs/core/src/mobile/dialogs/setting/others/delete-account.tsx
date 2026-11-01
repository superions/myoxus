import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { AuthService } from "@myoxus/core/modules/server";
import { UserFriendlyError } from "@myoxus/error";
import { Trans, useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { ConfirmModal, notify, useConfirmModal } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import { RowLayout } from "../row.layout";

export const DeleteAccount = () => {
  const t = useI18n();
  const authService = useService(AuthService);
  const session = authService.session;
  const account = useLiveData(session.account$);
  const [showModal, setShowModal] = useState(false);

  const openModal = useCallback(() => {
    setShowModal(true);
  }, []);

  return (
    <>
      {account ? (
        <RowLayout
          label={t["com.myoxus.mobile.setting.others.delete-account"]()}
          onClick={openModal}
        >
          <ArrowRightSmallIcon aria-hidden />
        </RowLayout>
      ) : null}
      <DeleteAccountModal open={showModal} onOpenChange={setShowModal} />
    </>
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
  const [isLoading, setIsLoading] = useState(false);
  const { openConfirmModal } = useConfirmModal();
  const navigate = useNavigate();
  const onConfirm = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const handleDeleteAccount = useCallback(async () => {
    try {
      setIsLoading(true);
      await authService.deleteAccount();
      track.$.$.auth.deleteAccount();
      openConfirmModal({
        title: t["com.myoxus.setting.account.delete.success-title"](),
        description: (
          <>
            <span>
              {t["com.myoxus.setting.account.delete.success-description-1"]()}
            </span>
            <br />
            <span>
              {t["com.myoxus.setting.account.delete.success-description-2"]()}
            </span>
          </>
        ),
        onCancel: false,
        confirmText: t["Confirm"](),
        onConfirm,
        confirmButtonOptions: {
          variant: "primary",
        },
      });
    } catch (err) {
      console.error(err);
      const error = UserFriendlyError.fromAny(err);
      notify.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [authService, onConfirm, openConfirmModal, t]);

  const onDeleteAccountConfirm = useAsyncCallback(async () => {
    await handleDeleteAccount();
  }, [handleDeleteAccount]);

  const onCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!account) {
    return null;
  }
  return (
    <ConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.setting.account.delete.confirm-title"]()}
      description={
        <Trans
          i18nKey="com.myoxus.setting.account.delete.confirm-description-2"
          components={{
            1: <strong />,
          }}
        />
      }
      confirmText={t["com.myoxus.setting.account.delete.confirm-button"]()}
      confirmButtonOptions={{
        variant: "error",
        disabled: isLoading,
        loading: isLoading,
        onClick: onDeleteAccountConfirm,
      }}
      onCancel={onCancel}
      cancelText={t["Cancel"]()}
      cancelButtonOptions={{
        variant: "primary",
      }}
      rowFooter
    />
  );
};
