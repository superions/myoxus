import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { useI18n } from "@myoxus/i18n";
import { NumberIcon } from "@myoxus/icons/react";
import { Input, PlaceholderText, PropertyValue } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import type { PropertyValueProps } from "../properties/types";

export const NumberValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const parsedValue = isNaN(Number(value)) ? null : value;
  const [tempValue, setTempValue] = useState(parsedValue);
  const handleBlur = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value.trim());
    },
    [onChange],
  );
  const t = useI18n();
  useEffect(() => {
    setTempValue(parsedValue);
  }, [parsedValue]);
  return (
    <PropertyValue isEmpty={!parsedValue} readonly={readonly}>
      <Input
        aria-label={t[
          "com.myoxus.page-properties.property-value-placeholder"
        ]()}
        type="number"
        inputMode="decimal"
        value={tempValue || ""}
        onChange={(next) => setTempValue(next.trim())}
        onBlur={handleBlur}
        data-empty={!tempValue}
        placeholder={t[
          "com.myoxus.page-properties.property-value-placeholder"
        ]()}
        disabled={readonly}
        block
        noBorder
      />
    </PropertyValue>
  );
};

export const NumberFilterValue = ({
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
  const [tempValue, setTempValue] = useState(filter.value || "");
  const [valueMenuOpen, setValueMenuOpen] = useState(false);
  const t = useI18n();

  useEffect(() => {
    // update temp value with new filter value
    setTempValue(filter.value || "");
  }, [filter.value]);

  const submitTempValue = useCallback(() => {
    if (tempValue !== (filter.value || "")) {
      onChange?.({
        ...filter,
        value: tempValue,
      });
    }
  }, [filter, onChange, tempValue]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Escape") return;
      submitTempValue();
      setValueMenuOpen(false);
      onDraftCompleted?.();
    },
    [submitTempValue, onDraftCompleted],
  );

  const handleInputEnter = useCallback(() => {
    submitTempValue();
    setValueMenuOpen(false);
    onDraftCompleted?.();
  }, [submitTempValue, onDraftCompleted]);

  useEffect(() => {
    if (
      isDraft &&
      (filter.method === "is-not-empty" || filter.method === "is-empty")
    ) {
      onDraftCompleted?.();
    }
  }, [isDraft, filter.method, onDraftCompleted]);

  return filter.method !== "is-not-empty" && filter.method !== "is-empty" ? (
    <FilterValueMenu
      rootOptions={{
        open: valueMenuOpen,
        onOpenChange: setValueMenuOpen,
        onClose: onDraftCompleted,
      }}
      contentOptions={{
        onPointerDownOutside: submitTempValue,
      }}
      items={
        <Input
          type="number"
          inputMode="decimal"
          autoFocus
          autoSelect
          value={tempValue}
          onChange={(value) => {
            setTempValue(value);
          }}
          onEnter={handleInputEnter}
          onKeyDown={handleInputKeyDown}
        />
      }
    >
      {filter.value ? (
        <span>{filter.value}</span>
      ) : (
        <PlaceholderText>{t["com.myoxus.filter.empty"]()}</PlaceholderText>
      )}
    </FilterValueMenu>
  ) : null;
};

export const NumberDocListProperty = ({ value }: { value: number }) => {
  if (value !== 0 && !value) {
    return null;
  }

  return <StackProperty icon={<NumberIcon />}>{value}</StackProperty>;
};

export const NumberGroupHeader = ({ groupId, docCount }: GroupHeaderProps) => {
  const t = useI18n();
  const number = groupId || t["com.myoxus.filter.empty"]();
  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {number}
    </PlainTextDocGroupHeader>
  );
};
