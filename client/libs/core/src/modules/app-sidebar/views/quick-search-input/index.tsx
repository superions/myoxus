import { useI18n } from "@myoxus/i18n";
import { SearchIcon } from "@myoxus/icons/react";
import { SidebarNavItem } from "@myoxus/ui-facade";
import type { HTMLAttributes } from "react";

interface QuickSearchInputProps extends HTMLAttributes<HTMLElement> {
  onClick?: () => void;
}

// Although it is called an input, it is actually a button.
export function QuickSearchInput({ onClick, ...props }: QuickSearchInputProps) {
  const t = useI18n();

  return (
    <SidebarNavItem {...props} icon={<SearchIcon />} onClick={onClick}>
      {t["Quick search"]()}
    </SidebarNavItem>
  );
}
