import { useI18n } from "@myoxus/i18n";
import {
  ArchiveRestoreIcon,
  CloseIcon,
  DeleteIcon,
  DeletePermanentlyIcon,
} from "@myoxus/icons/react";
import type { ReactNode } from "react";

import { FloatingToolbar } from "./floating-toolbar";

export const ListFloatingToolbar = ({
  content,
  onClose,
  open,
  onDelete,
  onRestore,
  actions,
}: {
  open: boolean;
  content: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
}) => {
  const t = useI18n();
  return (
    <FloatingToolbar open={open} placement="bottom-overlay">
      <FloatingToolbar.Item>{content}</FloatingToolbar.Item>
      {actions ? <FloatingToolbar.Item>{actions}</FloatingToolbar.Item> : null}
      <FloatingToolbar.Button
        onClick={onClose}
        icon={<CloseIcon />}
        tooltip={t["admin.common.close"]()}
      />
      {(!!onRestore || !!onDelete) && <FloatingToolbar.Separator />}
      {!!onRestore && (
        <FloatingToolbar.Button
          onClick={onRestore}
          icon={<ArchiveRestoreIcon />}
          tooltip={t["com.myoxus.all-docs.quick-action.restore"]()}
          data-testid="list-toolbar-restore"
        />
      )}
      {!!onDelete && (
        <FloatingToolbar.Button
          onClick={onDelete}
          icon={onRestore ? <DeletePermanentlyIcon /> : <DeleteIcon />}
          type="danger"
          tooltip={
            onRestore
              ? t["com.myoxus.all-docs.quick-action.delete-permanently"]()
              : t["admin.common.delete"]()
          }
          data-testid="list-toolbar-delete"
        />
      )}
    </FloatingToolbar>
  );
};
