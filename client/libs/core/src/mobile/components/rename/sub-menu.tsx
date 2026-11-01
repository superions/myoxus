import { useI18n } from "@myoxus/i18n";
import { EditIcon } from "@myoxus/icons/react";
import { MobileMenuSub, useMobileMenuController } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { RenameContent } from "./content";
import type { RenameSubMenuProps } from "./type";

export const RenameSubMenu = ({
  initialName = "",
  title,
  icon,
  text,
  children,
  menuProps,
  onConfirm,
  disabled,
  ...props
}: RenameSubMenuProps) => {
  const t = useI18n();
  const { close } = useMobileMenuController();

  const handleRename = useCallback(
    (value: string) => {
      onConfirm?.(value);
      close();
    },
    [close, onConfirm],
  );

  const { triggerOptions, ...otherMenuProps } = menuProps ?? {};
  return (
    <MobileMenuSub
      triggerOptions={{
        prefixIcon: icon ?? <EditIcon />,
        suffixIcon: null,
        disabled,
        ...triggerOptions,
      }}
      items={
        children ?? (
          <RenameContent
            initialName={initialName}
            onConfirm={handleRename}
            {...props}
          />
        )
      }
      title={title}
      {...otherMenuProps}
    >
      {text ?? t["com.myoxus.m.explorer.folder.rename"]()}
    </MobileMenuSub>
  );
};
