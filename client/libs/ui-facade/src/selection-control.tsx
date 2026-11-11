// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type CSSProperties,
  type ReactNode,
  type HTMLAttributes,
  type MouseEventHandler,
  type ComponentProps,
} from "react";
import {
  SegmentedControl,
  VisuallyHidden,
  Box,
  Checkbox as MantineCheckbox,
  Radio as MantineRadio,
  Slider as MantineSlider,
} from "@mantine/core";
import { reactNodeText } from "./helpers/accessibility";
import { settingsControlWideWidth } from "./settings/tokens";
import { cssVar } from "@myoxus/theme";
import { type MyoxusUiRoleProp } from "./helpers/ui-role";
import { DoneIcon } from "@myoxus/icons/react";

export type MyoxusSegmentedControlProps = {
  value?: string;
  data: ReadonlyArray<{ value: string; label: ReactNode; testId?: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
  testId?: string;
  layout?: "settings" | "fluid" | "sidebar";
  "aria-label"?: string;
  "data-myoxus-ui-role"?: string;
};

export function MyoxusSegmentedControl({
  value,
  data,
  disabled,
  onChange,
  testId,
  layout = "settings",
  "aria-label": ariaLabel,
  "data-myoxus-ui-role": uiRole,
}: MyoxusSegmentedControlProps) {
  const isSidebarLayout = layout === "sidebar";
  const hasFluidWidth = layout === "fluid" || isSidebarLayout;
  const selectedValue = value ?? data[0]?.value;

  return (
    <SegmentedControl
      disabled={disabled}
      data-testid={testId}
      aria-label={ariaLabel}
      data-myoxus-ui-role={
        uiRole ??
        (isSidebarLayout
          ? "sidebar-segmented-control"
          : "settings-segmented-control")
      }
      value={value}
      data={data.map(({ value: itemValue, label, testId }) => {
        const selected = selectedValue === itemValue;

        return {
          value: itemValue,
          label: (
            <span
              data-active={selected ? "true" : "false"}
              data-testid={testId}
              data-value={itemValue}
            >
              {label}
              {reactNodeText(label) ? null : (
                <VisuallyHidden>{itemValue}</VisuallyHidden>
              )}
            </span>
          ),
        };
      })}
      onChange={onChange}
      fullWidth
      attributes={{
        label: {
          "data-myoxus-ui-role": "settings-segmented-label",
        },
      }}
      styles={{
        root: {
          width: "100%",
          maxWidth: hasFluidWidth ? undefined : settingsControlWideWidth,
          background: cssVar("backgroundSecondaryColor"),
          borderColor: cssVar("borderColor"),
          color: cssVar("textPrimaryColor"),
        },
        control: {
          color: cssVar("textPrimaryColor"),
        },
        indicator: {
          background: cssVar("backgroundPrimaryColor"),
          borderColor: cssVar("borderColor"),
        },
        label: {
          color: cssVar("textPrimaryColor"),
        },
        innerLabel: {
          color: cssVar("textPrimaryColor"),
        },
      }}
    />
  );
}

export type SelectionIndicatorProps = Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> &
  MyoxusUiRoleProp & {
    selected: boolean;
    reserveSpace?: boolean;
    size?: number | string;
  };

export function SelectionIndicator({
  selected,
  reserveSpace = true,
  size,
  style,
  ...props
}: SelectionIndicatorProps) {
  if (!selected && !reserveSpace) return null;

  const indicatorSize =
    size ?? "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";
  return (
    <Box
      {...props}
      component="span"
      aria-hidden="true"
      data-selected={selected ? "true" : "false"}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "selection-indicator"
      }
      style={{
        width: indicatorSize,
        height: indicatorSize,
        display: "inline-flex",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        color: cssVar("primaryColor"),
        opacity: selected ? 1 : 0,
        ...style,
      }}
    >
      <DoneIcon style={{ width: "100%", height: "100%" }} />
    </Box>
  );
}

export type CheckboxProps = {
  checked: boolean;
  onChange?: (
    event: React.ChangeEvent<HTMLInputElement>,
    checked: boolean,
  ) => void;
  disabled?: boolean;
  indeterminate?: boolean;
  label?: ReactNode;
  className?: string;
  style?: CSSProperties;
  name?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  "data-testid"?: string;
  "aria-label"?: string;
  size?: ComponentProps<typeof MantineCheckbox>["size"];
};

export function Checkbox({
  checked,
  onChange,
  disabled,
  indeterminate,
  label,
  className,
  style,
  name,
  onClick,
  "data-testid": dataTestId,
  "aria-label": ariaLabel,
  size,
}: CheckboxProps) {
  return (
    <MantineCheckbox
      className={className}
      style={style}
      name={name}
      checked={checked}
      disabled={disabled}
      indeterminate={indeterminate}
      label={label}
      data-testid={dataTestId}
      aria-label={ariaLabel ?? (reactNodeText(label) || name || dataTestId)}
      size={size}
      data-myoxus-ui-role="settings-checkbox"
      onClick={onClick}
      onChange={(event) => onChange?.(event, event.currentTarget.checked)}
      styles={{
        // Typography's descendant margin reset must not displace the native checkbox glyph.
        icon: { margin: "auto" },
        label: {
          color: cssVar("textPrimaryColor"),
        },
      }}
    />
  );
}

export type RadioControlProps = {
  checked: boolean;
  onChange?: (
    event: React.ChangeEvent<HTMLInputElement>,
    checked: boolean,
  ) => void;
  disabled?: boolean;
  label?: ReactNode;
  className?: string;
  style?: CSSProperties;
  name?: string;
  "data-testid"?: string;
  "aria-label"?: string;
};

export function Radio({
  checked,
  onChange,
  disabled,
  label,
  className,
  style,
  name,
  "data-testid": dataTestId,
  "aria-label": ariaLabel,
}: RadioControlProps) {
  return (
    <MantineRadio
      className={className}
      style={style}
      name={name}
      checked={checked}
      disabled={disabled}
      label={label}
      data-testid={dataTestId}
      aria-label={ariaLabel ?? reactNodeText(label) ?? name ?? dataTestId}
      data-myoxus-ui-role="settings-radio"
      onChange={(event) => onChange?.(event, event.currentTarget.checked)}
      styles={{
        label: {
          color: cssVar("textPrimaryColor"),
        },
      }}
    />
  );
}

export type RadioItem<TValue extends string = string> = {
  value: TValue;
  label?: ReactNode;
  testId?: string;
  previewFontFamily?: CSSProperties["fontFamily"];
  style?: CSSProperties;
  className?: string;
  disabled?: boolean;
  attrs?: Record<string, string | number | boolean | undefined>;
};

export type RadioProps<TValue extends string = any> = {
  items: RadioItem<TValue>[];
  value?: unknown;
  onChange?: (value: any) => void;
  block?: boolean;
  width?: number | string;
  className?: string;
  style?: CSSProperties;
  padding?: CSSProperties["padding"];
  gap?: CSSProperties["gap"];
  itemHeight?: CSSProperties["minHeight"];
  itemMinWidth?: CSSProperties["minWidth"];
  borderRadius?: CSSProperties["borderRadius"];
  indicatorClassName?: string;
  iconMode?: boolean;
  disabled?: boolean;
  "data-myoxus-ui-role"?: string;
};

export function RadioGroup({
  items,
  value,
  onChange,
  block,
  width,
  className,
  style,
  padding,
  gap,
  itemHeight,
  itemMinWidth,
  borderRadius,
  indicatorClassName,
  iconMode,
  disabled,
  "data-myoxus-ui-role": uiRole = "settings-radio-group",
}: RadioProps<any>) {
  const controlTextColor = disabled
    ? cssVar("textSecondaryColor")
    : cssVar("textPrimaryColor");
  const resolvedPadding =
    padding ?? (iconMode ? "var(--mantine-spacing-2xs)" : undefined);
  const resolvedGap =
    gap ?? (iconMode ? "var(--mantine-spacing-xs)" : undefined);
  const resolvedItemHeight =
    itemHeight ??
    (iconMode
      ? "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
      : undefined);
  const resolvedBorderRadius =
    borderRadius ?? (iconMode ? "var(--mantine-radius-sm)" : undefined);
  return (
    <SegmentedControl
      className={className}
      classNames={
        indicatorClassName ? { indicator: indicatorClassName } : undefined
      }
      value={value == null ? undefined : String(value)}
      data={items.map(
        ({
          value: itemValue,
          label,
          previewFontFamily,
          style,
          className,
          disabled,
          testId,
          attrs,
        }) => ({
          value: String(itemValue),
          label: (
            <span
              className={className}
              style={
                style || previewFontFamily
                  ? {
                      fontFamily: previewFontFamily,
                      ...style,
                    }
                  : undefined
              }
              {...attrs}
              data-testid={testId}
            >
              {label}
              {reactNodeText(label) ? null : (
                <VisuallyHidden>{String(itemValue)}</VisuallyHidden>
              )}
            </span>
          ),
          disabled,
        }),
      )}
      onChange={(next) => {
        const selected = items.find((item) => String(item.value) === next);
        onChange?.(selected?.value ?? next);
      }}
      disabled={disabled}
      style={{ width: block ? "100%" : width, ...style }}
      data-myoxus-ui-role={uiRole}
      attributes={{ label: { "data-myoxus-ui-role": "settings-radio-label" } }}
      styles={{
        root: {
          ...(disabled
            ? {
                background: cssVar("backgroundSecondaryColor"),
                borderColor: cssVar("borderColor"),
                color: controlTextColor,
              }
            : {}),
          ...(resolvedPadding !== undefined
            ? { padding: resolvedPadding }
            : {}),
          ...(resolvedGap !== undefined ? { gap: resolvedGap } : {}),
          ...(resolvedBorderRadius !== undefined
            ? { borderRadius: resolvedBorderRadius }
            : {}),
        },
        control: {
          ...(disabled ? { color: controlTextColor } : {}),
          ...(resolvedItemHeight === undefined
            ? {}
            : { minHeight: resolvedItemHeight }),
          ...(itemMinWidth === undefined ? {} : { minWidth: itemMinWidth }),
        },
        indicator: {
          ...(disabled
            ? {
                background: cssVar("backgroundPrimaryColor"),
                borderColor: cssVar("borderColor"),
              }
            : {}),
          ...(resolvedItemHeight !== undefined
            ? { minHeight: resolvedItemHeight }
            : {}),
          ...(resolvedBorderRadius !== undefined
            ? { borderRadius: resolvedBorderRadius }
            : {}),
        },
        label: {
          ...(disabled ? { color: controlTextColor } : {}),
          ...(resolvedItemHeight !== undefined
            ? {
                alignItems: "center",
                display: "flex",
                minHeight: resolvedItemHeight,
              }
            : {}),
          ...(itemMinWidth !== undefined
            ? {
                minWidth: itemMinWidth,
              }
            : {}),
          ...(iconMode ? { justifyContent: "center", paddingInline: 0 } : {}),
        },
        innerLabel: {
          ...(disabled ? { color: controlTextColor } : {}),
          ...(itemHeight !== undefined
            ? {
                alignItems: "center",
                display: "flex",
                minHeight: itemHeight,
              }
            : {}),
          ...(itemMinWidth !== undefined
            ? {
                minWidth: itemMinWidth,
              }
            : {}),
        },
      }}
    />
  );
}

export function Slider({
  value,
  onChange,
  onValueChange,
  min,
  max,
  step,
  nodes,
  disabled,
  className,
  style,
  block,
  thumbLabel,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value?: number | number[];
  onChange?: (value: number) => void;
  onValueChange?: (value: number[]) => void;
  min?: number;
  max?: number;
  step?: number;
  nodes?: number[];
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  block?: boolean;
  thumbLabel?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const numericValue = Array.isArray(value) ? value[0] : value;
  return (
    <MantineSlider
      value={numericValue}
      onChange={(next) => {
        onChange?.(next);
        onValueChange?.([next]);
      }}
      min={min}
      max={max}
      step={step}
      marks={nodes?.map((node) => ({ value: node }))}
      disabled={disabled}
      className={className}
      style={{
        width: block ? "100%" : undefined,
        ...style,
      }}
      thumbLabel={thumbLabel ?? ariaLabel}
      thumbProps={
        ariaLabelledBy ? { "aria-labelledby": ariaLabelledBy } : undefined
      }
      data-myoxus-ui-role="settings-slider"
    />
  );
}
