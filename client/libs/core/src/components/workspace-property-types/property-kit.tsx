// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { useI18n } from "@myoxus/i18n";
import {
  Input,
  MenuItem,
  PlaceholderText,
  PropertyValue,
} from "@myoxus/ui-facade";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";

export interface PropertyFilterProps {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
  onChange?: (filter: FilterParams) => void;
}

export interface PropertyFilterOption {
  value: string;
  label: string;
  selected?: boolean;
}

export const PropertyFieldCell = PropertyValue;

export const PropertyListBadge = StackProperty;

export const PropertyGroupHeader = PlainTextDocGroupHeader;

export const PropertyFilterMenu = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
  options,
  displayLabel,
}: PropertyFilterProps & {
  options: readonly PropertyFilterOption[];
  displayLabel: string;
}) => (
  <FilterValueMenu
    isDraft={isDraft}
    onDraftCompleted={onDraftCompleted}
    items={
      <>
        {options.map((option) => (
          <MenuItem
            key={option.value}
            onClick={() => onChange?.({ ...filter, value: option.value })}
            selected={
              option.selected !== undefined
                ? option.selected
                : filter.value === option.value
            }
          >
            {option.label}
          </MenuItem>
        ))}
      </>
    }
  >
    <span>{displayLabel}</span>
  </FilterValueMenu>
);

export const BooleanPropertyFilterMenu = (props: PropertyFilterProps) => (
  <PropertyFilterMenu
    {...props}
    options={[
      { value: "true", label: "True", selected: props.filter.value === "true" },
      {
        value: "false",
        label: "False",
        selected: props.filter.value !== "true",
      },
    ]}
    displayLabel={props.filter.value === "true" ? "True" : "False"}
  />
);

export const PropertyInputFilterMenu = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
  inputProps,
}: PropertyFilterProps & {
  inputProps?: Partial<ComponentProps<typeof Input>>;
}) => {
  const t = useI18n();
  const [draft, setDraft] = useState(filter.value || "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setDraft(filter.value || "");
  }, [filter.value]);

  const commitDraft = useCallback(() => {
    if (draft !== (filter.value || "")) {
      onChange?.({ ...filter, value: draft });
    }
  }, [draft, filter, onChange]);

  const closeAndCommit = useCallback(() => {
    commitDraft();
    setOpen(false);
    onDraftCompleted?.();
  }, [commitDraft, onDraftCompleted]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      closeAndCommit();
    },
    [closeAndCommit],
  );

  useEffect(() => {
    if (
      isDraft &&
      (filter.method === "is-not-empty" || filter.method === "is-empty")
    ) {
      onDraftCompleted?.();
    }
  }, [filter.method, isDraft, onDraftCompleted]);

  if (filter.method === "is-not-empty" || filter.method === "is-empty") {
    return null;
  }

  return (
    <FilterValueMenu
      isDraft={isDraft}
      rootOptions={{
        open,
        onOpenChange: setOpen,
        onClose: onDraftCompleted,
      }}
      contentOptions={{ onPointerDownOutside: commitDraft }}
      items={
        <Input
          autoFocus
          autoSelect
          value={draft}
          onChange={setDraft}
          onEnter={closeAndCommit}
          onKeyDown={handleKeyDown}
          {...inputProps}
        />
      }
    >
      {filter.value ? (
        <span>{filter.value}</span>
      ) : (
        <PlaceholderText>{t["com.myoxus.filter.empty"]()}</PlaceholderText>
      )}
    </FilterValueMenu>
  );
};

export const createMappedGroupHeader = (
  resolveLabel: (groupId: string, t: ReturnType<typeof useI18n>) => ReactNode,
) =>
  function MappedGroupHeader({ groupId, docCount }: GroupHeaderProps) {
    const t = useI18n();
    return (
      <PropertyGroupHeader groupId={groupId} docCount={docCount}>
        {resolveLabel(groupId, t)}
      </PropertyGroupHeader>
    );
  };
