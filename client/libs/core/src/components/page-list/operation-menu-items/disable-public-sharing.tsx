import { useI18n } from "@myoxus/i18n";
import { ShareIcon } from "@myoxus/icons/react";
import { MenuItem, type MenuItemProps } from "@myoxus/ui-facade";

export const DisablePublicSharing = (props: MenuItemProps) => {
  const t = useI18n();
  return (
    <MenuItem type="danger" prefixIcon={<ShareIcon />} {...props}>
      {t["Disable Public Sharing"]()}
    </MenuItem>
  );
};
