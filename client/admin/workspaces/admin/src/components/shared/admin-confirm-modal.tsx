// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { ConfirmModal, type ConfirmModalProps } from "@myoxus/ui-facade";

export interface AdminConfirmModalProps extends ConfirmModalProps {
  danger?: boolean;
}

/**
 * Localizes Admin defaults while the shared Facade owns all dialog chrome,
 * typography, sizing, busy state and footer behavior.
 */
export function AdminConfirmModal({
  cancelButtonOptions,
  cancelText,
  closeOnConfirm = false,
  confirmButtonOptions,
  confirmText,
  danger = false,
  ...props
}: AdminConfirmModalProps) {
  const i18n = useI18n();

  return (
    <ConfirmModal
      {...props}
      cancelText={cancelText ?? i18n.t("admin.common.cancel")}
      confirmText={confirmText ?? i18n.t("admin.common.confirm")}
      closeOnConfirm={closeOnConfirm}
      cancelButtonOptions={{
        "data-testid": "admin-confirm-modal-cancel",
        ...cancelButtonOptions,
      }}
      confirmButtonOptions={{
        "data-testid": "admin-confirm-modal-confirm",
        ...confirmButtonOptions,
        ...(danger ? { variant: "error" } : undefined),
      }}
    />
  );
}
