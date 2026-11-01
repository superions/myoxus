import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import {
  FilterChipSegment,
  type FilterChipTone,
  FilterChipTrigger,
  FilterChipValueSlot,
  Menu,
  MenuItem,
} from "@myoxus/ui-facade";
import type React from "react";

import { FilterOptionsGroup } from "../options";

export const Condition = ({
  filter,
  isDraft,
  onDraftCompleted,
  icon,
  name,
  tone = "primary",
  methods,
  onChange,
  value: Value,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  icon?: React.ReactNode;
  name: React.ReactNode;
  tone?: FilterChipTone;
  methods?: [string, React.ReactNode][];
  onChange?: (filter: FilterParams) => void;
  value?: React.ElementType<{
    filter: FilterParams;
    isDraft?: boolean;
    onDraftCompleted?: () => void;
    onChange?: (filter: FilterParams) => void;
  }>;
}) => {
  return (
    <>
      <FilterChipSegment icon={icon} tone={tone}>
        {name}
      </FilterChipSegment>
      <FilterOptionsGroup
        isDraft={isDraft}
        onDraftCompleted={onDraftCompleted}
        initialStep={methods && methods.length > 1 ? 0 : 1}
        items={[
          methods &&
            (({ onDraftCompleted, menuRef }) => {
              return (
                <Menu
                  key={"method"}
                  ref={menuRef}
                  rootOptions={{
                    onClose: onDraftCompleted,
                  }}
                  items={methods.map(([method, name]) => (
                    <MenuItem
                      onClick={() => {
                        onChange?.({
                          ...filter,
                          method,
                        });
                      }}
                      selected={filter.method === method}
                      key={method}
                    >
                      {name}
                    </MenuItem>
                  ))}
                >
                  <FilterChipTrigger data-testid="filter-method">
                    {methods.find(
                      ([method]) => method === filter.method,
                    )?.[1] ?? "unknown"}
                  </FilterChipTrigger>
                </Menu>
              );
            }),
          Value &&
            (({ isDraft, onDraftCompleted }) => (
              <FilterChipValueSlot key={"value"} data-testid="filter-value">
                <Value
                  filter={filter}
                  isDraft={isDraft}
                  onDraftCompleted={onDraftCompleted}
                  onChange={onChange}
                />
              </FilterChipValueSlot>
            )),
        ]}
      />
    </>
  );
};
