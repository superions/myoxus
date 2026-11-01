import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { useI18n } from "@myoxus/i18n";
import { TextIcon, TextTypeIcon } from "@myoxus/icons/react";
import {
  Input,
  MyoxusText,
  PlaceholderText,
  PropertyValue,
  Textarea,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";

import { PlainTextDocGroupHeader } from "../explorer/docs-view/group-header";
import { StackProperty } from "../explorer/docs-view/stack-property";
import type { GroupHeaderProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import { ConfigModal } from "../mobile";
import type { PropertyValueProps } from "../properties/types";

const DesktopTextValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const [tempValue, setTempValue] = useState<string>(value);
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);
  const ref = useRef<HTMLTextAreaElement>(null);
  const handleBlur = useCallback(
    (e: FocusEvent) => {
      onChange((e.currentTarget as HTMLTextAreaElement).value.trim());
    },
    [onChange],
  );
  // use native blur event to get event after unmount
  // don't use useLayoutEffect here, cause the cleanup function will be called before unmount
  useEffect(() => {
    const textarea = ref.current;
    textarea?.addEventListener("blur", handleBlur);
    return () => {
      textarea?.removeEventListener("blur", handleBlur);
    };
  }, [handleBlur]);
  const t = useI18n();
  useEffect(() => {
    setTempValue(value);
  }, [value]);

  return (
    <PropertyValue onClick={handleClick} isEmpty={!value} readonly={readonly}>
      <Textarea
        ref={ref}
        aria-label={t[
          "com.myoxus.page-properties.property-value-placeholder"
        ]()}
        value={tempValue || ""}
        onChange={setTempValue}
        onClick={handleClick}
        autosize
        minRows={1}
        autoFocus={false}
        placeholder={t[
          "com.myoxus.page-properties.property-value-placeholder"
        ]()}
        disabled={readonly}
      />
    </PropertyValue>
  );
};

const MobileTextValue = ({
  value,
  onChange,
  propertyInfo,
}: PropertyValueProps) => {
  const [open, setOpen] = useState(false);

  const [tempValue, setTempValue] = useState<string>(value || "");
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(true);
  }, []);
  const ref = useRef<HTMLTextAreaElement>(null);
  const handleBlur = useCallback(
    (e: FocusEvent) => {
      onChange((e.currentTarget as HTMLTextAreaElement).value.trim());
    },
    [onChange],
  );
  // use native blur event to get event after unmount
  // don't use useLayoutEffect here, cause the cleanup function will be called before unmount
  useEffect(() => {
    const textarea = ref.current;
    textarea?.addEventListener("blur", handleBlur);
    return () => {
      textarea?.removeEventListener("blur", handleBlur);
    };
  }, [handleBlur]);
  const onClose = useCallback(() => {
    setOpen(false);
    onChange(tempValue.trim());
  }, [onChange, tempValue]);
  const t = useI18n();
  useEffect(() => {
    setTempValue(value || "");
  }, [value]);
  const placeholder =
    t["com.myoxus.page-properties.property-value-placeholder"]();

  return (
    <>
      <PropertyValue onClick={handleClick} isEmpty={!value}>
        {tempValue ? (
          <MyoxusText component="span" preserveWhitespace typographySlot="body">
            {tempValue}
          </MyoxusText>
        ) : (
          <PlaceholderText>{placeholder}</PlaceholderText>
        )}
      </PropertyValue>
      <ConfigModal
        open={open}
        onOpenChange={setOpen}
        onBack={onClose}
        title={
          <>
            <TextIcon />
            {propertyInfo?.name}
          </>
        }
      >
        <Textarea
          ref={ref}
          aria-label={placeholder}
          value={tempValue || ""}
          onChange={setTempValue}
          autosize
          minRows={1}
          autoFocus
          placeholder={placeholder}
        />
      </ConfigModal>
    </>
  );
};

export const TextValue = BUILD_CONFIG.isMobileWeb
  ? MobileTextValue
  : DesktopTextValue;

export const TextFilterValue = ({
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
      isDraft={isDraft}
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

export const TextDocListProperty = ({ value }: { value: string }) => {
  if (!value) {
    return null;
  }

  return <StackProperty icon={<TextTypeIcon />}>{value}</StackProperty>;
};

export const TextGroupHeader = ({ groupId, docCount }: GroupHeaderProps) => {
  const text = groupId || "No Text";
  return (
    <PlainTextDocGroupHeader groupId={groupId} docCount={docCount}>
      {text}
    </PlainTextDocGroupHeader>
  );
};
