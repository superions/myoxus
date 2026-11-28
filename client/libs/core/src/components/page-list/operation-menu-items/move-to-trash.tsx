// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DeleteIcon } from "@myoxus/icons/react";
import {
  ConfirmModal,
  type ConfirmModalProps,
  MenuItem,
  type MenuItemProps,
} from "@myoxus/ui-facade";

const MoveToTrashConfirm = ({
  titles,
  ...confirmModalProps
}: {
  titles: string[];
} & ConfirmModalProps) => {
  const t = useI18n();
  const isMultiple = titles.length > 1;
  const title = isMultiple
    ? t["com.myoxus.moveToTrash.confirmModal.title.multiple"]({
        number: String(titles.length),
      })
    : t["com.myoxus.moveToTrash.confirmModal.title"]();
  const description = isMultiple
    ? t["com.myoxus.moveToTrash.confirmModal.description.multiple"]({
        number: String(titles.length),
      })
    : t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: titles[0] || t["Untitled"](),
      });

  return (
    <ConfirmModal
      title={title}
      description={description}
      cancelText={t["com.myoxus.confirmModal.button.cancel"]()}
      confirmText={t.Delete()}
      confirmButtonOptions={{
        ["data-testid" as string]: "confirm-delete-page",
        variant: "error",
      }}
      {...confirmModalProps}
    />
  );
};

export const MoveToTrash = (props: MenuItemProps) => {
  const t = useI18n();
  return (
    <MenuItem prefixIcon={<DeleteIcon />} type="danger" {...props}>
      {t["com.myoxus.moveToTrash.title"]()}
    </MenuItem>
  );
};

MoveToTrash.ConfirmModal = MoveToTrashConfirm;
