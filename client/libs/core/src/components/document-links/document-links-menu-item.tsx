import { useI18n } from "@myoxus/i18n";
import { LinkIcon } from "@myoxus/icons/react";
import { Badge, MenuItem } from "@myoxus/ui-facade";

import { useDocumentLinkCounts } from "./document-links-content";

type DocumentLinksMenuItemProps = {
  onSelect: () => void;
  visible: boolean;
};

export function DocumentLinksMenuItem({
  onSelect,
  visible,
}: DocumentLinksMenuItemProps) {
  const t = useI18n();
  const { totalCount } = useDocumentLinkCounts(visible);
  const label = t["com.myoxus.document-links.title"]();

  return (
    <MenuItem
      prefixIcon={<LinkIcon />}
      suffix={
        totalCount === undefined ? undefined : (
          <Badge aria-label={`${label}: ${totalCount}`}>{totalCount}</Badge>
        )
      }
      data-testid="editor-option-menu-document-links"
      onSelect={onSelect}
    >
      {label}
    </MenuItem>
  );
}
