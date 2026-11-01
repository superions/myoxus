// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type SelectProps,
  type ComboboxItem,
  type PopoverProps,
  rem,
  Select as MantineSelect,
  Text,
  TagsInput as MantineTagsInput,
  Pill as MantinePill,
  type MultiSelectProps,
  MultiSelect as MantineMultiSelect,
} from "@mantine/core";
import {
  type CSSProperties,
  type PropsWithChildren,
  forwardRef,
  type ComponentProps,
  type ForwardedRef,
} from "react";
import { reactNodeText } from "./helpers/accessibility";
import {
  settingsControlWideWidth,
  settingsControlMaxWidth,
} from "./settings/tokens";
import { useI18n } from "@myoxus/i18n";
import { useModalPortalTarget } from "./modal";

function useSelectComboboxProps(props?: SelectProps["comboboxProps"]) {
  const target = useModalPortalTarget();
  // Escape the content scroller while inheriting the owning ModalStack layer.
  return {
    ...(target
      ? { portalProps: { target }, zIndex: "var(--mb-z-index)" }
      : undefined),
    ...props,
  };
}

export type MyoxusSelectProps = Omit<
  SelectProps,
  "onChange" | "data" | "onClear"
> & {
  data: ComboboxItem[];
  onChange: (value: string) => void;
  onClear?: () => void;
  block?: boolean;
  contentSized?: boolean;
  controlMaxWidth?: CSSProperties["maxWidth"];
};

export type FormSelectProps = Omit<
  SelectProps,
  "onChange" | "data" | "onClear"
> & {
  data: ComboboxItem[];
  onChange: (value: string) => void;
  onClear?: () => void;
};

export function FormSelect({
  data,
  onChange,
  onClear,
  ...props
}: FormSelectProps) {
  const comboboxProps = useSelectComboboxProps(props.comboboxProps);
  const ariaLabel =
    props["aria-label"] ??
    reactNodeText(props.label) ??
    (typeof props.placeholder === "string" ? props.placeholder : undefined);
  return (
    <MantineSelect
      {...props}
      comboboxProps={comboboxProps}
      aria-label={ariaLabel}
      data={data}
      data-myoxus-ui-role="form-select"
      onChange={(value) => {
        if (value === null) onClear?.();
        else onChange(value);
      }}
    />
  );
}

export function MyoxusSelect({
  block = false,
  contentSized = false,
  data,
  onChange,
  onClear,
  controlMaxWidth,
  wrapperProps,
  ...props
}: MyoxusSelectProps) {
  const comboboxProps = useSelectComboboxProps(props.comboboxProps);
  const ariaLabel =
    props["aria-label"] ??
    reactNodeText(props.label) ??
    (typeof props.placeholder === "string" ? props.placeholder : undefined);
  return (
    <MantineSelect
      {...props}
      aria-label={ariaLabel}
      comboboxProps={
        contentSized
          ? {
              ...comboboxProps,
              width: "max-content",
            }
          : comboboxProps
      }
      data={data}
      data-myoxus-ui-role="settings-select"
      wrapperProps={{
        ...wrapperProps,
        "data-myoxus-ui-role":
          wrapperProps?.["data-myoxus-ui-role"] ?? "settings-select-root",
      }}
      onChange={(value) => {
        if (value === null) onClear?.();
        else onChange(value);
      }}
      styles={{
        input: contentSized
          ? {
              fieldSizing: "content",
            }
          : undefined,
        root: {
          width: contentSized ? "fit-content" : "100%",
          maxWidth: contentSized
            ? "100%"
            : block
              ? "100%"
              : (controlMaxWidth ?? settingsControlWideWidth),
        },
      }}
    />
  );
}

export function PlaceholderText({ children }: PropsWithChildren) {
  return (
    <Text
      component="span"
      data-myoxus-ui-role="placeholder-text"
      c="myoxus-text-muted"
    >
      {children}
    </Text>
  );
}

/** Native free-value input; the Facade owns localized pill removal semantics. */
// Mantine owns tag entry and suggestions; removal remains named and keyboard-reachable.
export const TagsInput = forwardRef<
  HTMLInputElement,
  ComponentProps<typeof MantineTagsInput> & {
    removeLabel?: (value: string) => string;
  }
>(function TagsInput({ renderPill, readOnly, removeLabel, ...props }, ref) {
  const t = useI18n();
  return (
    <MantineTagsInput
      {...props}
      readOnly={readOnly}
      ref={ref}
      data-myoxus-ui-role="form-tags-input"
      renderPill={
        renderPill ??
        (({ value, onRemove, disabled, reorderProps }) => (
          <MantinePill
            {...reorderProps}
            withRemoveButton={!readOnly}
            disabled={disabled}
            onRemove={onRemove}
            removeButtonProps={{
              "aria-label": removeLabel?.(String(value)) ?? t.t("Delete"),
              "aria-hidden": false,
              tabIndex: 0,
            }}
          >
            {value}
          </MantinePill>
        ))
      }
    />
  );
});

// Coalesce Floating's measurements as in the Facade Popover: resizing a
// ScrollArea during ResizeObserver delivery can otherwise create a resize loop.
const pendingMultiSelectHeights = new WeakMap<HTMLElement, number>();
const multiSelectViewportMiddlewares: NonNullable<PopoverProps["middlewares"]> =
  {
    flip: true,
    shift: true,
    size: {
      padding: 5,
      apply({ availableHeight, elements }) {
        const element = elements.floating;
        const pending = pendingMultiSelectHeights.has(element);
        pendingMultiSelectHeights.set(element, availableHeight);
        if (pending) return;
        requestAnimationFrame(() => {
          const height = pendingMultiSelectHeights.get(element)!;
          pendingMultiSelectHeights.delete(element);
          if (element.isConnected)
            element.style.setProperty(
              "--myoxus-combobox-available-height",
              `${Math.max(0, height)}px`,
            );
        });
      },
    },
  };

export type MyoxusMultiSelectProps = Omit<
  MultiSelectProps,
  "onChange" | "data"
> & {
  data: Array<{ value: string; label: string }> | string[];
  onChange?: (value: string[]) => void;
  block?: boolean;
  fitViewport?: boolean;
  controlMaxWidth?: CSSProperties["maxWidth"];
};

export const MultiSelect = forwardRef(function MultiSelect(
  {
    block = false,
    fitViewport = false,
    data,
    onChange,
    controlMaxWidth,
    wrapperProps,
    renderPill,
    readOnly,
    ...props
  }: MyoxusMultiSelectProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const t = useI18n();
  const comboboxProps = useSelectComboboxProps(props.comboboxProps);
  const availableHeight =
    "max(0px, calc(var(--myoxus-combobox-available-height, 100vh) - var(--combobox-padding) * 2))";
  return (
    <MantineMultiSelect
      {...props}
      // Match single-select layering without changing caller portal overrides.
      comboboxProps={{
        middlewares: fitViewport ? multiSelectViewportMiddlewares : undefined,
        ...comboboxProps,
      }}
      maxDropdownHeight={
        fitViewport
          ? props.maxDropdownHeight === undefined
            ? availableHeight
            : `min(${rem(props.maxDropdownHeight)}, ${availableHeight})`
          : props.maxDropdownHeight
      }
      ref={ref}
      data={data}
      readOnly={readOnly}
      renderPill={
        renderPill ??
        (({ option, value, onRemove, disabled, reorderProps }) => (
          <MantinePill
            {...reorderProps}
            disabled={disabled || props.disabled}
            withRemoveButton={!readOnly && !option?.disabled}
            onRemove={onRemove}
            removeButtonProps={{
              disabled: disabled || props.disabled,
              "aria-label": t.t("Delete"),
              "aria-hidden": false,
              tabIndex: 0,
            }}
          >
            {option?.label || value}
          </MantinePill>
        ))
      }
      data-myoxus-ui-role="form-multi-select"
      wrapperProps={{
        ...wrapperProps,
        "data-myoxus-ui-role":
          wrapperProps?.["data-myoxus-ui-role"] ?? "form-multi-select-root",
      }}
      onChange={(value) => onChange?.(value)}
      styles={{
        root: {
          width: "100%",
          maxWidth: block
            ? "100%"
            : (controlMaxWidth ?? settingsControlMaxWidth),
        },
      }}
    />
  );
});

export const MyoxusMultiSelect = MultiSelect;

export const Select = MyoxusSelect;

export const Combobox = MyoxusSelect;
