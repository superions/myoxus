import {
  FilterChipTrigger,
  Menu,
  type MenuProps,
  type MenuRef,
} from "@myoxus/ui-facade";
import { useEffect, useRef } from "react";

export const FilterValueMenu = ({
  children,
  isDraft,
  rootOptions,
  contentOptions,
  onDraftCompleted,
  ...otherProps
}: { isDraft?: boolean; onDraftCompleted?: () => void } & MenuProps) => {
  const menuRef = useRef<MenuRef>(null);

  useEffect(() => {
    if (isDraft) {
      menuRef.current?.changeOpen(true);
    }
  }, [isDraft]);

  return (
    <Menu
      ref={menuRef}
      rootOptions={{
        onClose: onDraftCompleted,
        ...rootOptions,
      }}
      contentOptions={{
        ...contentOptions,
      }}
      {...otherProps}
    >
      <FilterChipTrigger data-myoxus-ui-role="filter-chip-value-trigger">
        {children}
      </FilterChipTrigger>
    </Menu>
  );
};
