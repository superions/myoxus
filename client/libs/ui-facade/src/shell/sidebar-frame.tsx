// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps, type MyoxusUiRoleProp } from "../helpers/ui-role";
import {
  Box,
  Group,
  Splitter as MantineSplitter,
  Stack,
  Splitter,
} from "@mantine/core";
import {
  type ReactNode,
  type HTMLAttributes,
  type PropsWithChildren,
  forwardRef,
  type ComponentProps,
  type Ref,
} from "react";
import { ArrowLeftSmallIcon, ArrowRightSmallIcon } from "@myoxus/icons/react";
import { cssVar } from "@myoxus/theme";
import { IconButton, type MyoxusIconButtonProps } from "../button";
import { MyoxusText, type MyoxusTextProps } from "../typography";
import {
  BrandAssetImage,
  type BrandAssetImageProps,
} from "../brand-asset-image";
import { useResponsiveSmQuery } from "../responsive";

/** Persistent navigation frame and server-owned brand presentation. */

/**
 * Native Splitter geometry shared by controlled shell state and pane bounds.
 * Mantine reads bounds from its direct children and accepts px/rem fixed sizes,
 * not CSS variable expressions. Keep these values in the shell owner.
 */
export const shellPanelSizes = {
  navigationExpanded: "15.5rem",
  navigationCollapsed: "57px",
  detailMax: "24rem",
} as const;

export const ShellSidebarPanel = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof Splitter.Pane>
>(function ShellSidebarPanel({ style, ...props }, ref) {
  return (
    <Splitter.Pane
      {...props}
      ref={ref}
      data-myoxus-ui-role="shell-sidebar-panel"
      style={{
        background: cssVar("backgroundPrimaryColor"),
        borderRight: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        overflow: "visible",
        ...style,
      }}
    />
  );
});

/**
 * Viewport slot for shell chrome that should exist only in narrow layouts.
 * Route modules declare the slot; the Facade owns the Mantine breakpoint read.
 */
export function ShellMobileViewportSlot({ children }: PropsWithChildren) {
  return useResponsiveSmQuery() ? children : null;
}

/**
 * Counterpart to `ShellMobileViewportSlot` for resizable desktop shell panels.
 * Keeping this boundary here prevents product shells from carrying local
 * `matchMedia` hooks or hard-coded breakpoints.
 */
export function ShellDesktopViewportSlot({ children }: PropsWithChildren) {
  return useResponsiveSmQuery() ? null : children;
}

export function ShellSidebarInner({
  children,
  ...props
}: PropsWithChildren<{ className?: string }>) {
  return (
    <Stack
      {...props}
      h="100%"
      w="100%"
      gap={0}
      data-myoxus-ui-role="shell-sidebar-inner"
    >
      {children}
    </Stack>
  );
}

export function ShellSidebarBrand({
  children,
  collapsed = false,
  ...props
}: PropsWithChildren<{ className?: string; collapsed?: boolean }>) {
  return (
    <Group
      {...props}
      align="center"
      c={cssVar("textPrimaryColor")}
      gap="xs"
      h={"calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))"}
      justify={collapsed ? "center" : "space-between"}
      px={collapsed ? "xs" : "md"}
      wrap="nowrap"
      data-myoxus-ui-role="shell-sidebar-brand"
    >
      {children}
    </Group>
  );
}

export function ShellBrandInline({
  children,
  ...props
}: PropsWithChildren<{ className?: string }>) {
  return (
    <Group {...props} component="span" gap="xs" wrap="nowrap">
      {children}
    </Group>
  );
}

export function ShellBrandLogo({
  compact = false,
  style,
  ...props
}: BrandAssetImageProps & { compact?: boolean }) {
  return (
    <BrandAssetImage
      {...props}
      style={{
        height: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        marginLeft: compact
          ? 0
          : "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
        marginRight: compact ? 0 : "var(--mantine-spacing-xs)",
        maxWidth: compact ? "5rem" : "8rem",
        objectFit: "contain",
        width: "auto",
        ...style,
      }}
    />
  );
}

/**
 * Compact presentation of the server-projected Myoxus wordmark. It preserves
 * the same asset used by the authentication shell while fitting the persistent
 * workspace navigation header.
 */
export function ShellBrandWordmark({ style, ...props }: BrandAssetImageProps) {
  return (
    <BrandAssetImage
      {...props}
      slot="logo"
      style={{
        display: "block",
        height: "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs))",
        maxWidth: "8rem",
        objectFit: "contain",
        width: "auto",
        ...style,
      }}
    />
  );
}

export function SidebarControlStrip({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "sidebar-control-strip",
  ...props
}: RoleBoxProps) {
  // Right-sidebar controls share outer spacing here so product panels do not
  // keep local margin wrappers around Mantine-backed control primitives.
  return (
    <Box
      {...props}
      px={"var(--mantine-spacing-lg)"}
      py={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      style={{ width: "100%", ...style }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export function SidebarCalendarPanel({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "sidebar-calendar-panel",
  ...props
}: RoleBoxProps) {
  // Sidebar calendar hosts share centering and panel rhythm here; product
  // panels should not keep route-local wrappers just to fit a DatePicker.
  return (
    <Box
      {...props}
      px={"var(--mantine-spacing-lg)"}
      pt={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      pb={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}
      style={{
        display: "flex",
        justifyContent: "center",
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export type SidebarDateStepperProps = {
  label: ReactNode;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  previousIcon?: ReactNode;
  nextIcon?: ReactNode;
  previousTestId?: string;
  nextTestId?: string;
  labelTestId?: string;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
};

export function SidebarDateStepper({
  label,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  previousIcon = <ArrowLeftSmallIcon />,
  nextIcon = <ArrowRightSmallIcon />,
  previousTestId,
  nextTestId,
  labelTestId,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "sidebar-date-stepper",
}: SidebarDateStepperProps) {
  return (
    <SidebarControlStrip data-testid={dataTestId} data-myoxus-ui-role={uiRole}>
      <Group
        align="center"
        gap={"var(--mantine-spacing-sm)"}
        justify="space-between"
        wrap="nowrap"
        style={{
          width: "100%",
          border: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
            "borderColor",
          )}`,
          borderRadius: "var(--mantine-radius-lg)",
          background: cssVar("backgroundPrimaryColor"),
          paddingBlock:
            "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
          paddingInline: "var(--mantine-spacing-sm)",
        }}
        data-myoxus-ui-role="sidebar-date-stepper-surface"
      >
        <IconButton
          aria-label={previousLabel}
          data-testid={previousTestId}
          onClick={onPrevious}
          size="default"
        >
          {previousIcon}
        </IconButton>
        <MyoxusText
          component="span"
          data-testid={labelTestId}
          data-myoxus-ui-role="sidebar-date-stepper-label"
          tone="primary"
          truncate
          typographySlot="body-small"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            textAlign: "center",
            textTransform: "capitalize",
          }}
        >
          {label}
        </MyoxusText>
        <IconButton
          aria-label={nextLabel}
          data-testid={nextTestId}
          onClick={onNext}
          size="default"
        >
          {nextIcon}
        </IconButton>
      </Group>
    </SidebarControlStrip>
  );
}

export type SidebarLayoutSlotProps = HTMLAttributes<HTMLDivElement> &
  MyoxusUiRoleProp;

export function ShellSidebarToggle({
  collapsed: _collapsed = false,
  children,
  ...props
}: PropsWithChildren<MyoxusIconButtonProps & { collapsed?: boolean }>) {
  return <IconButton {...props}>{children}</IconButton>;
}

export const ShellRightPanel = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof MantineSplitter.Pane>
>(function ShellRightPanel({ style, ...props }, ref) {
  return (
    <MantineSplitter.Pane
      {...props}
      ref={ref}
      data-myoxus-ui-role="shell-right-panel"
      style={{
        background: cssVar("backgroundPrimaryColor"),
        borderLeft: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        // Splitter min/max constrain resize actions, not controlled render
        // values. This cap also bounds opening/reopening the detail pane.
        maxWidth: shellPanelSizes.detailMax,
        ...style,
      }}
    />
  );
});

export function ShellPanelScroll({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <Box
      className={className}
      h="100%"
      style={{ overflowY: "auto" }}
      data-myoxus-ui-role="shell-panel-scroll"
    >
      {children}
    </Box>
  );
}

export function SidebarHeaderControls({
  children,
  "data-myoxus-ui-role": uiRole = "sidebar-header-controls",
  ...props
}: PropsWithChildren<SidebarLayoutSlotProps>) {
  // Header composition is shared so route shells do not keep local sidebar
  // header width and spacing CSS after moving rows to Mantine NavLink.
  return (
    <Group
      {...props}
      align="center"
      gap={"var(--mantine-spacing-sm)"}
      justify="space-between"
      mih={
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
      }
      pe={"calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))"}
      ps={"calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))"}
      w="100%"
      wrap="nowrap"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Group>
  );
}

function createSidebarFlexibleSlot(defaultRole: string) {
  return function SidebarFlexibleBoxSlot({
    children,
    "data-myoxus-ui-role": uiRole = defaultRole,
    ...props
  }: PropsWithChildren<SidebarLayoutSlotProps>) {
    return (
      <Box {...props} flex="1 1 auto" miw={0} data-myoxus-ui-role={uiRole}>
        {children}
      </Box>
    );
  };
}

export const SidebarHeaderMainSlot = createSidebarFlexibleSlot(
  "sidebar-header-main-slot",
);

export function SidebarQuickActionRow({
  children,
  "data-myoxus-ui-role": uiRole = "sidebar-quick-action-row",
  ...props
}: PropsWithChildren<SidebarLayoutSlotProps>) {
  // Quick actions share the same row rhythm as navigation items while keeping
  // the search trigger flexible and the create button fixed.
  return (
    <Group
      {...props}
      align="center"
      gap={"var(--mantine-spacing-sm)"}
      py={"var(--mantine-spacing-xs)"}
      w="100%"
      wrap="nowrap"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Group>
  );
}

export const SidebarFlexibleSlot = createSidebarFlexibleSlot(
  "sidebar-flexible-slot",
);

export function SidebarFooterStack({
  children,
  "data-myoxus-ui-role": uiRole = "sidebar-footer-stack",
  ...props
}: PropsWithChildren<SidebarLayoutSlotProps>) {
  return (
    <Stack
      {...props}
      gap={"var(--mantine-spacing-sm)"}
      w="100%"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Stack>
  );
}

export const SidebarFooterBar = forwardRef(function SidebarFooterBar(
  {
    children,
    "data-myoxus-ui-role": uiRole = "sidebar-footer-bar",
    ...props
  }: PropsWithChildren<SidebarLayoutSlotProps>,
  ref: Ref<HTMLDivElement>,
) {
  // Bottom toolbars in sidebars share spacing and truncation behavior here so
  // Journal, workspace and account sidebars do not recreate footer CSS.
  return (
    <Group
      {...props}
      ref={ref}
      align="center"
      gap={"var(--mantine-spacing-sm)"}
      px={"var(--mantine-spacing-lg)"}
      py={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Group>
  );
});

export function SidebarFooterCaption({
  children,
  tone = "muted",
  "data-myoxus-ui-role": uiRole = "sidebar-footer-caption",
  ...props
}: PropsWithChildren<
  MyoxusTextProps &
    MyoxusUiRoleProp & {
      tone?: "muted" | "warning";
    }
>) {
  return (
    <MyoxusText
      {...props}
      component="span"
      flex={1}
      minWidth={0}
      tone={tone === "warning" ? "warning" : "secondary"}
      truncate
      typographySlot="label-compact"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </MyoxusText>
  );
}
