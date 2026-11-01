// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type ButtonHTMLAttributes,
  forwardRef,
} from "react";
import { type MyoxusUiRoleProp } from "./helpers/ui-role";
import { ColorSwatch } from "./color-swatch";
import { ArrowDownSmallIcon } from "@myoxus/icons/react";
import {
  Box,
  ThemeIcon as MantineThemeIcon,
  Group,
  Text,
  Button as MantineButton,
} from "@mantine/core";
import { menuIconContent } from "./helpers/menu-icon";

export type FilterChipTone =
  "primary" | "secondary" | "placeholder" | "danger" | "disabled";

type FilterBarProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> &
    MyoxusUiRoleProp & {
      wrap?: boolean;
    }
>;

type FilterBarSpacerProps = HTMLAttributes<HTMLSpanElement> &
  MyoxusUiRoleProp & {
    grow?: CSSProperties["flexGrow"];
  };

type FilterChipProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> &
    MyoxusUiRoleProp & {
      active?: boolean;
      draft?: boolean;
    }
>;

type FilterChipSegmentProps = PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> &
    MyoxusUiRoleProp & {
      icon?: ReactNode;
      tone?: FilterChipTone;
      truncate?: boolean;
    }
>;

type FilterChipValueSlotProps = PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> & MyoxusUiRoleProp
>;

type FilterChipTriggerProps = PropsWithChildren<
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "prefix" | "type"> &
    MyoxusUiRoleProp & {
      prefix?: ReactNode;
      suffix?: ReactNode;
      tone?: Exclude<FilterChipTone, "danger">;
      type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
    }
>;

type SwatchSelectTriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> &
  MyoxusUiRoleProp & {
    color: string;
    dropdownIcon?: ReactNode;
    label: ReactNode;
    open?: boolean;
    type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
  };

const filterChipLabelOverflowStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function MenuColorSwatch({
  color,
  "aria-label": ariaLabel,
}: {
  color: string;
  "aria-label"?: string;
}) {
  return (
    <ColorSwatch
      aria-label={ariaLabel}
      color={color}
      shape="circle"
      size={"var(--mantine-spacing-xs)"}
      data-myoxus-ui-role="menu-color-swatch"
    />
  );
}

export const SwatchSelectTrigger = forwardRef<
  HTMLButtonElement,
  SwatchSelectTriggerProps
>(function SwatchSelectTrigger(
  {
    color,
    dropdownIcon = <ArrowDownSmallIcon />,
    label,
    open,
    style,
    type = "button",
    "data-myoxus-ui-role": uiRole = "swatch-select-trigger",
    ...props
  },
  ref,
) {
  return (
    <MantineButton
      {...props}
      aria-haspopup={props["aria-haspopup"] ?? "menu"}
      component="button"
      data-open={open ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      ref={ref}
      type={type}
      variant="default"
      leftSection={<MenuColorSwatch color={color} />}
      rightSection={
        <Box
          aria-hidden="true"
          component="span"
          data-myoxus-ui-role="swatch-select-trigger-icon"
        >
          {menuIconContent(dropdownIcon)}
        </Box>
      }
      style={{
        maxWidth: "100%",
        minWidth: 0,
        ...style,
      }}
    >
      <Box component="span" style={filterChipLabelOverflowStyle}>
        {label}
      </Box>
    </MantineButton>
  );
});

function FilterChipIcon({ children }: PropsWithChildren) {
  return (
    <MantineThemeIcon
      data-myoxus-ui-role="filter-chip-icon"
      size="sm"
      variant="transparent"
    >
      {menuIconContent(children)}
    </MantineThemeIcon>
  );
}

export function FilterBar({
  children,
  wrap = true,
  "data-myoxus-ui-role": uiRole = "filter-bar",
  ...props
}: FilterBarProps) {
  return (
    <Group
      {...props}
      data-myoxus-ui-role={uiRole}
      align="center"
      gap="xs"
      wrap={wrap ? "wrap" : "nowrap"}
    >
      {children}
    </Group>
  );
}

export function FilterBarSpacer({
  grow = 1,
  style,
  "data-myoxus-ui-role": uiRole = "filter-bar-spacer",
  ...props
}: FilterBarSpacerProps) {
  return (
    <Box
      {...props}
      component="span"
      data-myoxus-ui-role={uiRole}
      style={{
        flex: `${grow} 1 auto`,
        minWidth: 0,
        ...style,
      }}
    />
  );
}

export function FilterChip({
  active,
  children,
  draft,
  "data-myoxus-ui-role": uiRole = "filter-chip",
  ...props
}: FilterChipProps) {
  return (
    <Group
      {...props}
      data-active={active ? "true" : undefined}
      data-draft={draft ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      align="center"
      gap="xs"
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export function FilterChipSegment({
  children,
  icon,
  style,
  tone = "primary",
  truncate = true,
  "data-myoxus-ui-role": uiRole = "filter-chip-segment",
  ...props
}: FilterChipSegmentProps) {
  return (
    <Group
      {...props}
      component="span"
      data-tone={tone}
      data-myoxus-ui-role={uiRole}
      align="center"
      gap="xs"
      wrap="nowrap"
      style={style}
    >
      {icon ? <FilterChipIcon>{icon}</FilterChipIcon> : null}
      <Text component="span" truncate={truncate ? "end" : undefined}>
        {children}
      </Text>
    </Group>
  );
}

export function FilterChipValueSlot({
  children,
  "data-myoxus-ui-role": uiRole = "filter-chip-value-slot",
  ...props
}: FilterChipValueSlotProps) {
  return (
    <Group
      {...props}
      component="span"
      data-myoxus-ui-role={uiRole}
      align="center"
      gap="xs"
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export const FilterChipTrigger = forwardRef<
  HTMLButtonElement,
  FilterChipTriggerProps
>(function FilterChipTrigger(
  {
    children,
    prefix,
    suffix,
    style,
    tone = "secondary",
    type = "button",
    "data-myoxus-ui-role": uiRole = "filter-chip-trigger",
    ...props
  },
  ref,
) {
  return (
    <MantineButton
      {...props}
      component="button"
      ref={ref}
      type={type}
      data-tone={tone}
      data-myoxus-ui-role={uiRole}
      color={tone === "primary" ? "myoxus" : undefined}
      leftSection={prefix ? menuIconContent(prefix) : undefined}
      rightSection={suffix ? menuIconContent(suffix) : undefined}
      radius="xl"
      size="xs"
      variant={tone === "primary" ? "light" : "default"}
      style={style}
    >
      {children}
    </MantineButton>
  );
});
