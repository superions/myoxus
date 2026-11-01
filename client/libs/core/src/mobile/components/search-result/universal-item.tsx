import type { QuickSearchItem } from "@myoxus/core/modules/quicksearch";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import {
  MobileSelectorIconSlot,
  MobileSelectorItemLabel,
  MobileSelectorListItem,
} from "@myoxus/ui-facade";

import { SearchResLabel } from "./search-res-label";

export interface UniversalSearchResultItemProps {
  id: string;
  item: QuickSearchItem;
  category: "tag" | "collection";
}
export const UniversalSearchResultItem = ({
  id,
  item,
  category,
}: UniversalSearchResultItemProps) => {
  return (
    <MobileSelectorListItem
      component={WorkbenchLink}
      to={`/${category}/${id}`}
      data-myoxus-ui-role="mobile-search-result-item"
    >
      <MobileSelectorIconSlot data-myoxus-ui-role="mobile-search-result-icon">
        {item.icon &&
          (typeof item.icon === "function" ? <item.icon /> : item.icon)}
      </MobileSelectorIconSlot>

      <MobileSelectorItemLabel data-myoxus-ui-role="mobile-search-result-label">
        <SearchResLabel item={item} />
      </MobileSelectorItemLabel>

      <MobileSelectorIconSlot
        tone="disabled"
        data-myoxus-ui-role="mobile-search-result-suffix"
      >
        <ArrowRightSmallIcon />
      </MobileSelectorIconSlot>
    </MobileSelectorListItem>
  );
};
