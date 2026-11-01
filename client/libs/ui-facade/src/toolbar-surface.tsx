// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type CSSProperties,
  type MouseEventHandler,
  useCallback,
} from "react";
import { Card as MantineCard, Group, Box } from "@mantine/core";
import { joinClassName } from "./helpers/class-name";
import { type MyoxusIconButtonProps, IconButton } from "./button";
import { useResponsiveSmQuery } from "./responsive";
import { type RoleBoxProps } from "./helpers/ui-role";
import { type MyoxusTextProps, MyoxusText } from "./typography";

export type ToolbarSurfaceProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    compact?: boolean;
    justify?: CSSProperties["justifyContent"];
    placement?: "inline" | "bottom-overlay";
    "data-myoxus-ui-role"?: string;
  }
>;

export function ToolbarSurface({
  children,
  className,
  compact = false,
  justify = "flex-end",
  placement = "inline",
  "data-myoxus-ui-role": uiRole = "toolbar-surface",
  ...props
}: ToolbarSurfaceProps) {
  return (
    <MantineCard
      {...props}
      className={joinClassName("myoxus-ui-toolbar-surface", className)}
      data-compact={compact ? "true" : undefined}
      data-placement={placement === "inline" ? undefined : placement}
      data-myoxus-ui-role={uiRole}
      p="xs"
    >
      <Group
        data-myoxus-ui-role="toolbar-surface-content"
        gap="xs"
        justify={justify}
        wrap={compact ? "nowrap" : "wrap"}
      >
        {children}
      </Group>
    </MantineCard>
  );
}

export type FloatingActionDockProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    concealed?: boolean;
    elevated?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>;

/**
 * Floating action placement for persistent workspace tools. Product code owns
 * only visibility and domain offsets; facade CSS owns the viewport anchoring,
 * spacing and pointer-event behavior so routes do not grow local dock systems.
 */
export function FloatingActionDock({
  children,
  className,
  concealed = false,
  elevated = false,
  "data-myoxus-ui-role": uiRole = "floating-action-dock",
  ...props
}: FloatingActionDockProps) {
  return (
    <Box
      {...props}
      component="aside"
      className={joinClassName("myoxus-floating-action-dock", className)}
      data-concealed={concealed ? "true" : undefined}
      data-elevated={elevated ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export type FloatingActionResponsiveAction = {
  /**
   * Domain action for narrow workspaces. The facade decides when a viewport is
   * narrow by using the shared Mantine breakpoint projection; product code must
   * not import responsive hooks just to pick between action targets.
   */
  narrow: MouseEventHandler<HTMLButtonElement>;
  /**
   * Optional domain action for wide workspaces. It is used only when
   * `preferWide` is true and the shared facade breakpoint is not narrow.
   */
  wide?: MouseEventHandler<HTMLButtonElement>;
  preferWide?: boolean;
};

export type FloatingActionTriggerProps = MyoxusIconButtonProps & {
  concealed?: boolean;
  responsiveAction?: FloatingActionResponsiveAction;
};

/**
 * Tokenized floating action trigger. It deliberately reuses `IconButton` so
 * Mantine ActionIcon remains the interaction primitive while the facade owns
 * elevated chrome, hover overlay and hide/show motion.
 */
export function FloatingActionTrigger({
  className,
  concealed = false,
  onClick,
  responsiveAction,
  size,
  tabIndex,
  variant,
  "aria-disabled": ariaDisabled,
  "data-myoxus-ui-role": uiRole = "button:floating-action-trigger",
  ...props
}: FloatingActionTriggerProps) {
  const narrowViewport = useResponsiveSmQuery(false);
  const handleClick: MouseEventHandler<HTMLButtonElement> = useCallback(
    (event) => {
      if (concealed) return;
      if (!responsiveAction) {
        onClick?.(event);
        return;
      }
      if (responsiveAction.preferWide && !narrowViewport) {
        (responsiveAction.wide ?? responsiveAction.narrow)(event);
        return;
      }
      responsiveAction.narrow(event);
    },
    [concealed, narrowViewport, onClick, responsiveAction],
  );

  return (
    <IconButton
      {...props}
      className={joinClassName("myoxus-floating-action-trigger", className)}
      aria-disabled={concealed ? true : ariaDisabled}
      data-concealed={concealed ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      onClick={handleClick}
      size={size ?? "extraLarge"}
      tabIndex={concealed ? -1 : tabIndex}
      variant={variant ?? "solid"}
    />
  );
}

export type CanvasOverlayToolbarProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    "data-myoxus-ui-role"?: string;
  }
>;

/**
 * Transparent toolbar chrome for controls rendered above editor/canvas
 * surfaces. The root lets pointer events pass through so canvas selection
 * still works; facade CSS re-enables pointer events for real interactive
 * descendants.
 */
export function CanvasOverlayToolbar({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "canvas-overlay-toolbar",
  ...props
}: CanvasOverlayToolbarProps) {
  return (
    <Group
      {...props}
      className={joinClassName("myoxus-canvas-overlay-toolbar", className)}
      data-myoxus-ui-role={uiRole}
      align="center"
      gap={"var(--mantine-spacing-2xs)"}
      p={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export function CanvasOverlayTitleSlot({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "canvas-overlay-title-slot",
  ...props
}: CanvasOverlayToolbarProps) {
  return (
    <Group
      {...props}
      className={joinClassName("myoxus-canvas-overlay-title-slot", className)}
      data-myoxus-ui-role={uiRole}
      align="center"
      gap={"var(--mantine-spacing-2xs)"}
      p={"var(--mantine-spacing-2xs)"}
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export function CanvasOverlayTitleIcon({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "canvas-overlay-title-icon",
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      component="span"
      className={joinClassName("myoxus-canvas-overlay-title-icon", className)}
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}

export function CanvasOverlayTitleText({
  children,
  className,
  emphasis = "default",
  tone,
  "data-myoxus-ui-role": uiRole = "canvas-overlay-title-text",
  ...props
}: MyoxusTextProps & {
  emphasis?: "default" | "balanced" | "strong";
}) {
  const resolvedTone =
    tone ?? (emphasis === "default" ? "secondary" : "primary");
  return (
    <MyoxusText
      {...props}
      component="span"
      className={joinClassName("myoxus-canvas-overlay-title-text", className)}
      data-emphasis={emphasis === "default" ? undefined : emphasis}
      data-myoxus-ui-role={uiRole}
      fallbackSlot="body-small"
      tone={resolvedTone}
      typographySlot="nav"
    >
      {children}
    </MyoxusText>
  );
}
