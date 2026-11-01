import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { CloseIcon } from "@myoxus/icons/react";
import { FilterChip, IconButton } from "@myoxus/ui-facade";

import { PropertyFilterCondition } from "./conditions/property";
import { SystemFilterCondition } from "./conditions/system";

export const Filter = ({
  filter,
  isDraft,
  onDraftCompleted,
  onDelete,
  onChange,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onDelete: () => void;
  onChange: (filter: FilterParams) => void;
}) => {
  const type = filter.type;

  const Condition =
    type === "property"
      ? PropertyFilterCondition
      : type === "system"
        ? SystemFilterCondition
        : null;

  return (
    <FilterChip draft={isDraft} data-type={type}>
      {Condition ? (
        <Condition
          isDraft={isDraft}
          filter={filter}
          onChange={onChange}
          onDraftCompleted={onDraftCompleted}
        />
      ) : null}
      <IconButton
        aria-label="Remove filter"
        icon={<CloseIcon />}
        onClick={onDelete}
      />
    </FilterChip>
  );
};
