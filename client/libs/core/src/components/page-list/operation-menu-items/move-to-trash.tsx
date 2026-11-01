import { useI18n } from "@myoxus/i18n";
import { DeleteIcon } from "@myoxus/icons/react";
import {
  ConfirmModal,
  type ConfirmModalProps,
  MenuItem,
  type MenuItemProps,
} from "@myoxus/ui-facade";

export const MoveToTrash = (props: MenuItemProps) => {
  const t = useI18n();

  return (
    <MenuItem prefixIcon={<DeleteIcon />} type="danger" {...props}>
      {t["com.myoxus.moveToTrash.title"]()}
    </MenuItem>
  );
};

const MoveToTrashConfirm = ({
  titles,
  ...confirmModalProps
}: {
  titles: string[];
} & ConfirmModalProps) => {
  const t = useI18n();
  const multiple = titles.length > 1;
  const title = multiple
    ? t["com.myoxus.moveToTrash.confirmModal.title.multiple"]({
        number: titles.length.toString(),
      })
    : t["com.myoxus.moveToTrash.confirmModal.title"]();
  const description = multiple
    ? t["com.myoxus.moveToTrash.confirmModal.description.multiple"]({
        number: titles.length.toString(),
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

MoveToTrash.ConfirmModal = MoveToTrashConfirm;
