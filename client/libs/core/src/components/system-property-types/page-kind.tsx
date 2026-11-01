import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { useI18n } from "@myoxus/i18n";
import { MenuItem, MyoxusText } from "@myoxus/ui-facade";

import { FilterValueMenu } from "../filter/filter-value-menu";

const PAGE_KIND_VALUES = ["all", "document", "database"] as const;
type PageKindValue = (typeof PAGE_KIND_VALUES)[number];

const PAGE_KIND_I18N_KEYS = {
  all: "com.myoxus.workspace-pages.kind.all",
  document: "com.myoxus.workspace-pages.kind.documents",
  database: "com.myoxus.workspace-pages.kind.databases",
} as const;

export const PageKindFilterValue = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onChange?: (filter: FilterParams) => void;
}) => {
  const t = useI18n();
  const value: PageKindValue = PAGE_KIND_VALUES.includes(
    filter.value as PageKindValue,
  )
    ? (filter.value as PageKindValue)
    : "all";

  return (
    <FilterValueMenu
      isDraft={isDraft}
      onDraftCompleted={onDraftCompleted}
      items={PAGE_KIND_VALUES.map((candidate) => (
        <MenuItem
          key={candidate}
          onClick={() => onChange?.({ ...filter, value: candidate })}
          selected={value === candidate}
        >
          {t[PAGE_KIND_I18N_KEYS[candidate]]()}
        </MenuItem>
      ))}
    >
      <MyoxusText component="span" typographySlot="nav">
        {t[PAGE_KIND_I18N_KEYS[value]]()}
      </MyoxusText>
    </FilterValueMenu>
  );
};
