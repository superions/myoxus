import { useI18n } from "@myoxus/i18n";
import { EditIcon } from "@myoxus/icons/react";

import {
  RenameDialog,
  type RenameDialogProps,
  RenameSubMenu,
  type RenameSubMenuProps,
} from "../../../rename";

export const FolderCreateTip = ({
  input,
  parentName,
}: {
  input?: string;
  parentName?: string;
}) => {
  const t = useI18n();
  const parent = parentName
    ? parentName
    : t["com.myoxus.m.explorer.folder.root"]();

  const tip = input
    ? t["com.myoxus.m.explorer.folder.new-tip-not-empty"]({
        value: input,
        parent,
      })
    : t["com.myoxus.m.explorer.folder.new-tip-empty"]({ parent });

  return tip;
};

export const FolderRenameSubMenu = ({
  title: propsTitle,
  icon: propsIcon,
  text: propsText,
  ...props
}: RenameSubMenuProps) => {
  const t = useI18n();
  const title = propsTitle || t["com.myoxus.m.explorer.folder.rename"]();
  const icon = propsIcon || <EditIcon />;
  const text = propsText || title;

  return <RenameSubMenu title={title} icon={icon} text={text} {...props} />;
};

export const FolderRenameDialog = ({
  title: propsTitle,
  confirmText: propsConfirmText,
  ...props
}: RenameDialogProps & {
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) => {
  const t = useI18n();
  const title =
    propsTitle || t["com.myoxus.m.explorer.folder.new-dialog-title"]();
  const confirmText =
    propsConfirmText || t["com.myoxus.m.explorer.folder.rename-confirm"]();

  return <RenameDialog title={title} confirmText={confirmText} {...props} />;
};
