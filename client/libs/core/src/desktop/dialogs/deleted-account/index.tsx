// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import type {
  DialogComponentProps,
  GLOBAL_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { ConfirmModal } from "@myoxus/ui-facade";
import { useCallback } from "react";

export const DeletedAccountDialog = ({
  close,
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA["deleted-account"]>) => {
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();

  const handleAcknowledge = useCallback(() => {
    jumpToIndex();
    close();
  }, [close, jumpToIndex]);

  return (
    <ConfirmModal
      open
      persistent
      title={t["com.myoxus.setting.account.delete.success-title"]()}
      description={[
        t["com.myoxus.setting.account.delete.success-description-1"](),
        t["com.myoxus.setting.account.delete.success-description-2"](),
      ].join(" ")}
      confirmText={t["Confirm"]()}
      onOpenChange={handleAcknowledge}
      onConfirm={handleAcknowledge}
      onCancel={false}
      confirmButtonOptions={{ variant: "primary" }}
    />
  );
};
