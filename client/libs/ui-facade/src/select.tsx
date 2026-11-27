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
import { cssVar } from "@myoxus/theme";
import { reactNodeText } from "./helpers/accessibility";
import {
  settingsControlWideWidth,
  settingsControlMaxWidth,
} from "./settings/tokens";
import { useI18n } from "@myoxus/i18n";
import { useModalPortalTarget } from "./modal";

// Combobox forwards this native Popover option, but omits it from its narrowed type.
type SelectComboboxProps = NonNullable<SelectProps["comboboxProps"]> &
  Pick<PopoverProps, "clickOutsideEvents">;

const pendingComboboxHeights = new WeakMap<HTMLElement, number>();
const comboboxViewportMiddlewares: NonNullable<PopoverProps["middlewares"]> = {
  flip: true,
  shift: true,
  size: {
    padding: 5,
    apply({ availableHeight, elements }) {
      const element = elements.floating;
      const pending = pendingComboboxHeights.has(element);
      pendingComboboxHeights.set(element, availableHeight);
      if (pending) return;
      requestAnimationFrame(() => {
        const height = pendingComboboxHeights.get(element)!;
        pendingComboboxHeights.delete(element);
        if (element.isConnected)
          element.style.setProperty(
            "--myoxus-combobox-available-height",
            `${Math.max(0, height)}px`,
          );
      });
    },
  },
};

const COMBOBOX_AVAILABLE_HEIGHT =
  "max(0px, calc(var(--myoxus-combobox-available-height, 100vh) - var(--combobox-padding) * 2))";

function clampComboboxDropdownHeight(
  maxDropdownHeight: SelectProps["maxDropdownHeight"],
  embeddedDropdown: boolean,
) {
  if (embeddedDropdown) return maxDropdownHeight;
  return maxDropdownHeight === undefined
    ? COMBOBOX_AVAILABLE_HEIGHT
    : `min(${rem(maxDropdownHeight)}, ${COMBOBOX_AVAILABLE_HEIGHT})`;
}

function useSelectComboboxProps(
  props?: SelectComboboxProps,
  embeddedDropdown = false,
) {
  const target = useModalPortalTarget();
  if (embeddedDropdown) {
    return {
      ...props,
      withinPortal: false,
      shadow: undefined,
    };
  }
  // Escape the content scroller while inheriting the owning ModalStack or Popover layer.
  return {
    shadow: "md" as const,
    middlewares: comboboxViewportMiddlewares,
    ...(target
      ? { portalProps: { target }, zIndex: "var(--mb-z-index)" }
      : { zIndex: `calc(${cssVar("zIndexPopover")} + 1)` }),
    ...props,
  };
}

const embeddedDropdownStyles = {
  dropdown: {
    position: "static" as const,
    width: "100%",
    marginTop: "var(--mantine-spacing-xs)",
    border: "none",
    boxShadow: "none",
    padding: 0,
    background: "transparent",
  },
  options: {
    padding: 0,
  },
};

export type MyoxusSelectProps = Omit<
  SelectProps,
  "onChange" | "data" | "onClear" | "comboboxProps"
> & {
  comboboxProps?: SelectComboboxProps;
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
  /** Keep the options list in-flow inside an owning Popover card instead of stacking a second floating frame. */
  embeddedDropdown?: boolean;
};

export function FormSelect({
  data,
  onChange,
  onClear,
  embeddedDropdown = false,
  maxDropdownHeight = 280,
  scrollAreaProps,
  styles,
  ...props
}: FormSelectProps) {
  const comboboxProps = useSelectComboboxProps(
    props.comboboxProps,
    embeddedDropdown,
  );
  const ariaLabel =
    props["aria-label"] ??
    reactNodeText(props.label) ??
    (typeof props.placeholder === "string" ? props.placeholder : undefined);
  return (
    <MantineSelect
      {...props}
      comboboxProps={comboboxProps}
      maxDropdownHeight={clampComboboxDropdownHeight(
        maxDropdownHeight,
        embeddedDropdown,
      )}
      scrollAreaProps={{ type: "auto", ...scrollAreaProps }}
      styles={
        embeddedDropdown
          ? {
              ...embeddedDropdownStyles,
              ...(typeof styles === "object" ? styles : undefined),
            }
          : styles
      }
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
  maxDropdownHeight = 280,
  scrollAreaProps,
  styles,
  ...props
}: MyoxusSelectProps) {
  const comboboxProps = useSelectComboboxProps(props.comboboxProps);
  const callerStyles = typeof styles === "object" ? styles : undefined;
  const ariaLabel =
    props["aria-label"] ??
    reactNodeText(props.label) ??
    (typeof props.placeholder === "string" ? props.placeholder : undefined);
  return (
    <MantineSelect
      {...props}
      aria-label={ariaLabel}
      maxDropdownHeight={clampComboboxDropdownHeight(maxDropdownHeight, false)}
      scrollAreaProps={{ type: "auto", ...scrollAreaProps }}
      comboboxProps={
        contentSized
          ? {
              width: "max-content",
              ...comboboxProps,
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
        ...callerStyles,
        input: contentSized
          ? {
              fieldSizing: "content",
              ...callerStyles?.input,
            }
          : callerStyles?.input,
        root: {
          width: contentSized ? "fit-content" : "100%",
          maxWidth: contentSized
            ? "100%"
            : block
              ? "100%"
              : (controlMaxWidth ?? settingsControlWideWidth),
          ...callerStyles?.root,
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

export type MyoxusMultiSelectProps = Omit<
  MultiSelectProps,
  "onChange" | "data"
> & {
  data: Array<{ value: string; label: string }> | string[];
  onChange?: (value: string[]) => void;
  block?: boolean;
  fitViewport?: boolean;
  embeddedDropdown?: boolean;
  controlMaxWidth?: CSSProperties["maxWidth"];
};

export const MultiSelect = forwardRef(function MultiSelect(
  {
    block = false,
    fitViewport = false,
    embeddedDropdown = false,
    data,
    onChange,
    controlMaxWidth,
    wrapperProps,
    renderPill,
    readOnly,
    scrollAreaProps,
    ...props
  }: MyoxusMultiSelectProps,
  ref: ForwardedRef<HTMLInputElement>,
) {
  const t = useI18n();
  const comboboxProps = useSelectComboboxProps(
    props.comboboxProps,
    embeddedDropdown,
  );
  return (
    <MantineMultiSelect
      {...props}
      // Match single-select layering without changing caller portal overrides.
      comboboxProps={comboboxProps}
      maxDropdownHeight={
        fitViewport
          ? clampComboboxDropdownHeight(
              props.maxDropdownHeight,
              embeddedDropdown,
            )
          : clampComboboxDropdownHeight(
              props.maxDropdownHeight ?? 280,
              embeddedDropdown,
            )
      }
      scrollAreaProps={{ type: "auto", ...scrollAreaProps }}
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
        ...(embeddedDropdown ? embeddedDropdownStyles : undefined),
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
