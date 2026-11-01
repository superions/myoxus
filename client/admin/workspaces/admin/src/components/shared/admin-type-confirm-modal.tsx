// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { Input } from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { AdminConfirmModal } from "./admin-confirm-modal";

interface AdminTypeConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  targetText: string;
  inputPlaceholder?: string;
  cancelText?: string;
  confirmText?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

/** Requires an exact operator-entered value before a destructive action. */
export function AdminTypeConfirmModal({
  open,
  onOpenChange,
  title,
  description,
  targetText,
  inputPlaceholder,
  cancelText,
  confirmText,
  onConfirm,
  onCancel,
}: AdminTypeConfirmModalProps) {
  const i18n = useI18n();
  const [input, setInput] = useState("");

  const handleInput = useCallback((value: string) => {
    setInput(value);
  }, []);

  useEffect(() => {
    if (!open) setInput("");
  }, [open]);

  return (
    <AdminConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      cancelText={cancelText}
      confirmText={confirmText}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirmButtonOptions={{ disabled: input !== targetText }}
    >
      <Input
        autoFocus
        type="text"
        value={input}
        onChange={handleInput}
        placeholder={
          inputPlaceholder ?? i18n.t("admin.common.type-to-confirm-placeholder")
        }
      />
    </AdminConfirmModal>
  );
}
