import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { useI18n } from "@myoxus/i18n";
import { CheckBoxCheckLinearIcon } from "@myoxus/icons/react";
import { Checkbox, MenuItem, PropertyValue } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { DocListPropertyProps, GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import type { PropertyValueProps } from "../properties/types";

export const CheckboxValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const parsedValue = value === "true" ? true : false;
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (readonly) {
        return;
      }
      onChange(parsedValue ? "false" : "true");
    },
    [onChange, parsedValue, readonly],
  );
  return (
    <PropertyValue onClick={handleClick}>
      <Checkbox checked={parsedValue} onChange={() => {}} disabled={readonly} />
    </PropertyValue>
  );
};

export const CheckboxFilterValue = ({
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
  return (
    <FilterValueMenu
      isDraft={isDraft}
      onDraftCompleted={onDraftCompleted}
      items={
        <>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "true",
              });
            }}
            selected={filter.value === "true"}
          >
            {"True"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              onChange?.({
                ...filter,
                value: "false",
              });
            }}
            selected={filter.value !== "true"}
          >
            {"False"}
          </MenuItem>
        </>
      }
    >
      <span>{filter.value === "true" ? "True" : "False"}</span>
    </FilterValueMenu>
  );
};

export const CheckboxDocListProperty = ({
  value,
  propertyInfo,
}: DocListPropertyProps) => {
  const t = useI18n();
  if (!value) return null;

  return (
    <StackProperty icon={<CheckBoxCheckLinearIcon />}>
      {/* 
        Has circular dependency issue (WorkspacePropertyName -> WorkspacePropertyTypes -> Checkbox)
        <WorkspacePropertyName propertyInfo={propertyInfo} /> 
      */}
      {propertyInfo.name || t["unnamed"]()}
    </StackProperty>
  );
};

export const CheckboxGroupHeader = ({
  groupId,
  docCount,
}: GroupHeaderProps) => {
  const t = useI18n();
  const text =
    groupId === "true"
      ? t["com.myoxus.all-docs.group.is-checked"]()
      : t["com.myoxus.all-docs.group.is-not-checked"]();
  return (
    <PlainTextDocGroupHeader docCount={docCount} groupId={groupId}>
      {text}
    </PlainTextDocGroupHeader>
  );
};
