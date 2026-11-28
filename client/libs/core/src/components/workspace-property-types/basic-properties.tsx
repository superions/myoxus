// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { i18nTime, useI18n } from "@myoxus/i18n";
import {
  CheckBoxCheckLinearIcon,
  DateTimeIcon,
  NumberIcon,
  TextIcon,
  TextTypeIcon,
} from "@myoxus/icons/react";
import {
  Checkbox,
  DatePicker,
  Input,
  Menu,
  type MenuRef,
  MyoxusText,
  PlaceholderText,
  Textarea,
} from "@myoxus/ui-facade";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { DocListPropertyProps } from "../explorer/types";
import { FilterValueMenu } from "../filter/filter-value-menu";
import { FilterOptionsGroup } from "../filter/options";
import { ConfigModal } from "../mobile";
import type { PropertyValueProps } from "../properties/types";
import {
  BooleanPropertyFilterMenu,
  createMappedGroupHeader,
  PropertyFieldCell,
  type PropertyFilterProps,
  PropertyInputFilterMenu,
  PropertyListBadge,
} from "./property-kit";

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export const CheckboxValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const checked = value === "true";
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (readonly) return;
      onChange(checked ? "false" : "true");
    },
    [checked, onChange, readonly],
  );

  return (
    <PropertyFieldCell onClick={handleClick}>
      <Checkbox checked={checked} onChange={() => {}} disabled={readonly} />
    </PropertyFieldCell>
  );
};

export const CheckboxFilterValue = BooleanPropertyFilterMenu;

export const CheckboxDocListProperty = ({
  value,
  propertyInfo,
}: DocListPropertyProps) => {
  const t = useI18n();
  if (!value) return null;

  return (
    <PropertyListBadge icon={<CheckBoxCheckLinearIcon />}>
      {propertyInfo.name || t["unnamed"]()}
    </PropertyListBadge>
  );
};

export const CheckboxGroupHeader = createMappedGroupHeader((groupId, t) =>
  groupId === "true"
    ? t["com.myoxus.all-docs.group.is-checked"]()
    : t["com.myoxus.all-docs.group.is-not-checked"](),
);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const useNativeTextareaBlurCommit = (
  ref: React.RefObject<HTMLTextAreaElement | null>,
  onChange: (value: string) => void,
) => {
  const handleBlur = useCallback(
    (event: FocusEvent) => {
      onChange((event.currentTarget as HTMLTextAreaElement).value.trim());
    },
    [onChange],
  );

  // Native blur listener ensures edits flush even when the cell unmounts.
  useEffect(() => {
    const element = ref.current;
    element?.addEventListener("blur", handleBlur);
    return () => {
      element?.removeEventListener("blur", handleBlur);
    };
  }, [handleBlur, ref]);
};

const DesktopTextValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const t = useI18n();
  const [draft, setDraft] = useState<string>(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useNativeTextareaBlurCommit(textareaRef, onChange);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const stopClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
  }, []);

  const placeholder =
    t["com.myoxus.page-properties.property-value-placeholder"]();

  return (
    <PropertyFieldCell onClick={stopClick} isEmpty={!value} readonly={readonly}>
      <Textarea
        ref={textareaRef}
        aria-label={placeholder}
        value={draft || ""}
        onChange={setDraft}
        onClick={stopClick}
        autosize
        minRows={1}
        autoFocus={false}
        placeholder={placeholder}
        disabled={readonly}
      />
    </PropertyFieldCell>
  );
};

const MobileTextValue = ({
  value,
  onChange,
  propertyInfo,
}: PropertyValueProps) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(value || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useNativeTextareaBlurCommit(textareaRef, onChange);

  useEffect(() => {
    setDraft(value || "");
  }, [value]);

  const handleOpen = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    onChange(draft.trim());
  }, [draft, onChange]);

  const placeholder =
    t["com.myoxus.page-properties.property-value-placeholder"]();

  return (
    <>
      <PropertyFieldCell onClick={handleOpen} isEmpty={!value}>
        {draft ? (
          <MyoxusText component="span" preserveWhitespace typographySlot="body">
            {draft}
          </MyoxusText>
        ) : (
          <PlaceholderText>{placeholder}</PlaceholderText>
        )}
      </PropertyFieldCell>
      <ConfigModal
        open={open}
        onOpenChange={setOpen}
        onBack={handleClose}
        title={
          <>
            <TextIcon />
            {propertyInfo?.name}
          </>
        }
      >
        <Textarea
          ref={textareaRef}
          aria-label={placeholder}
          value={draft || ""}
          onChange={setDraft}
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

export const TextFilterValue = (props: PropertyFilterProps) => (
  <PropertyInputFilterMenu {...props} />
);

export const TextDocListProperty = ({ value }: { value: string }) =>
  value ? (
    <PropertyListBadge icon={<TextTypeIcon />}>{value}</PropertyListBadge>
  ) : null;

export const TextGroupHeader = createMappedGroupHeader(
  (groupId) => groupId || "No Text",
);

// ---------------------------------------------------------------------------
// Number
// ---------------------------------------------------------------------------

export const NumberValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const t = useI18n();
  const parsed = Number.isNaN(Number(value)) ? null : value;
  const [draft, setDraft] = useState(parsed);

  useEffect(() => {
    setDraft(parsed);
  }, [parsed]);

  const handleBlur = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange(event.target.value.trim());
    },
    [onChange],
  );

  const placeholder =
    t["com.myoxus.page-properties.property-value-placeholder"]();

  return (
    <PropertyFieldCell isEmpty={!parsed} readonly={readonly}>
      <Input
        aria-label={placeholder}
        type="number"
        inputMode="decimal"
        value={draft || ""}
        onChange={(next) => setDraft(next.trim())}
        onBlur={handleBlur}
        data-empty={!draft}
        placeholder={placeholder}
        disabled={readonly}
        block
        noBorder
      />
    </PropertyFieldCell>
  );
};

export const NumberFilterValue = (props: PropertyFilterProps) => (
  <PropertyInputFilterMenu
    {...props}
    inputProps={{ type: "number", inputMode: "decimal" }}
  />
);

export const NumberDocListProperty = ({ value }: { value: number }) =>
  value === 0 || Boolean(value) ? (
    <PropertyListBadge icon={<NumberIcon />}>{value}</PropertyListBadge>
  ) : null;

export const NumberGroupHeader = createMappedGroupHeader(
  (groupId, t) => groupId || t["com.myoxus.filter.empty"](),
);

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DateValue = ({
  value,
  onChange,
  readonly,
}: PropertyValueProps) => {
  const t = useI18n();
  const parsed =
    typeof value === "string" && ISO_DATE_PATTERN.test(value)
      ? value
      : undefined;
  const label = parsed
    ? i18nTime(parsed, { absolute: { accuracy: "day" } })
    : t["com.myoxus.page-properties.property-value-placeholder"]();

  const content = parsed ? label : <PlaceholderText>{label}</PlaceholderText>;

  if (readonly) {
    return (
      <PropertyFieldCell isEmpty={!parsed} readonly>
        {content}
      </PropertyFieldCell>
    );
  }

  return (
    <Menu items={<DatePicker value={parsed} onChange={onChange} />}>
      <PropertyFieldCell isEmpty={!parsed}>{content}</PropertyFieldCell>
    </Menu>
  );
};

const DatePickerFilterTrigger = ({
  ref,
  value,
  onChange,
  onClose,
}: {
  ref?: React.Ref<MenuRef>;
  value?: string;
  onChange: (value: string) => void;
  onClose?: () => void;
}) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) onClose?.();
    },
    [onClose],
  );

  useImperativeHandle(ref, () => ({ changeOpen: handleOpenChange }), [
    handleOpenChange,
  ]);

  const handlePick = useCallback(
    (date: string) => {
      onChange(date);
      setOpen(false);
      onClose?.();
    },
    [onChange, onClose],
  );

  return (
    <FilterValueMenu
      rootOptions={{ open, onOpenChange: handleOpenChange }}
      items={<DatePicker value={value || undefined} onChange={handlePick} />}
    >
      {value ? (
        <span>{value}</span>
      ) : (
        <PlaceholderText>{t["com.myoxus.filter.empty"]()}</PlaceholderText>
      )}
    </FilterValueMenu>
  );
};

const SingleDateFilterTrigger = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: PropertyFilterProps) => {
  const menuRef = useRef<MenuRef>(null);
  const firstDate = filter.value?.split(",")[0];

  useEffect(() => {
    if (isDraft) menuRef.current?.changeOpen(true);
  }, [isDraft]);

  return (
    <DatePickerFilterTrigger
      ref={menuRef}
      value={firstDate}
      onChange={(date) => onChange?.({ ...filter, value: date })}
      onClose={onDraftCompleted}
    />
  );
};

export const DateFilterValue = ({
  filter,
  isDraft,
  onDraftCompleted,
  onChange,
}: PropertyFilterProps) => {
  const parts = filter.value?.split(",") ?? [];

  useEffect(() => {
    if (
      isDraft &&
      filter.method !== "after" &&
      filter.method !== "before" &&
      filter.method !== "between"
    ) {
      onDraftCompleted?.();
    }
  }, [filter.method, isDraft, onDraftCompleted]);

  if (filter.method === "after" || filter.method === "before") {
    return (
      <SingleDateFilterTrigger
        filter={filter}
        isDraft={isDraft}
        onDraftCompleted={onDraftCompleted}
        onChange={onChange}
      />
    );
  }

  if (filter.method === "between") {
    return (
      <FilterOptionsGroup
        isDraft={isDraft}
        onDraftCompleted={onDraftCompleted}
        items={[
          ({ onDraftCompleted: done, menuRef }) => (
            <DatePickerFilterTrigger
              ref={menuRef}
              value={parts[0]}
              onChange={(start) =>
                onChange?.({ ...filter, value: `${start},${parts[1] || ""}` })
              }
              onClose={done}
            />
          ),
          <PlaceholderText key="between">&nbsp;-&nbsp;</PlaceholderText>,
          ({ onDraftCompleted: done, menuRef }) => (
            <DatePickerFilterTrigger
              ref={menuRef}
              value={parts[1]}
              onChange={(end) =>
                onChange?.({ ...filter, value: `${parts[0] || ""},${end}` })
              }
              onClose={done}
            />
          ),
        ]}
      />
    );
  }

  return undefined;
};

export const DateDocListProperty = ({ value }: DocListPropertyProps) =>
  value ? (
    <PropertyListBadge icon={<DateTimeIcon />}>
      {i18nTime(value, { absolute: { accuracy: "day" } })}
    </PropertyListBadge>
  ) : null;

export const DateGroupHeader = createMappedGroupHeader(
  (groupId) => groupId || "No Date",
);
