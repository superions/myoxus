// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import {
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useEffect,
} from "react";
import { Drawer as MantineDrawer, Box, Group } from "@mantine/core";
import { useResponsiveMdQuery } from "./responsive";
import { MyoxusText } from "./typography";

export type DrawerProps = RoleBoxProps & {
  open?: boolean;
  opened?: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  title?: ReactNode;
  description?: ReactNode;
  position?: "left" | "right" | "top" | "bottom";
  size?: number | string;
  withCloseButton?: boolean;
  closeButtonLabel?: string;
  withOverlay?: boolean;
  trapFocus?: boolean;
  lockScroll?: boolean;
  returnFocus?: boolean;
  /**
   * Durable focus target for drawers opened from cards or transient menus.
   * Focus is restored once when the controlled open state closes. A delayed
   * transition callback must not reclaim focus after the user has moved on.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  "aria-label"?: string;
};

export function Drawer({
  open,
  opened,
  onOpenChange,
  onClose,
  title,
  description,
  position = "right",
  size,
  withCloseButton = true,
  closeButtonLabel,
  withOverlay,
  trapFocus,
  lockScroll,
  returnFocus,
  returnFocusRef,
  children,
  className,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "drawer",
  "aria-label": ariaLabel,
}: DrawerProps) {
  const descriptionId = useId();
  const resolvedOpen = opened ?? !!open;
  const wasOpenRef = useRef(resolvedOpen);

  useEffect(() => {
    if (wasOpenRef.current && !resolvedOpen) {
      returnFocusRef?.current?.focus();
    }
    wasOpenRef.current = resolvedOpen;
  }, [resolvedOpen, returnFocusRef]);

  return (
    <MantineDrawer
      opened={resolvedOpen}
      withOverlay={withOverlay}
      trapFocus={trapFocus}
      lockScroll={lockScroll}
      returnFocus={returnFocus}
      onClose={() => {
        onClose?.();
        onOpenChange?.(false);
      }}
      title={title}
      position={position}
      size={size}
      withCloseButton={withCloseButton}
      closeButtonProps={
        closeButtonLabel ? { "aria-label": closeButtonLabel } : undefined
      }
      aria-label={ariaLabel}
      aria-describedby={description ? descriptionId : undefined}
      className={className}
      classNames={{ content: className }}
      styles={{ content: style }}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
    >
      {description ? (
        <MyoxusText
          component="div"
          id={descriptionId}
          mb="sm"
          tone="secondary"
          data-myoxus-ui-role="drawer-description"
        >
          {description}
        </MyoxusText>
      ) : null}
      <Box data-myoxus-ui-role="drawer-content">{children}</Box>
    </MantineDrawer>
  );
}

export const Sheet = Drawer;

export type DetailPeekProps = Omit<
  DrawerProps,
  | "lockScroll"
  | "position"
  | "returnFocus"
  | "size"
  | "trapFocus"
  | "withOverlay"
> & {
  actions?: ReactNode;
};

/**
 * Product-neutral, non-destructive detail surface. Desktop keeps the source
 * work area interactive; compact viewports use native Mantine modal behavior
 * and a full-width sheet. The responsive decision stays inside the Facade.
 */
export function DetailPeek({ actions, title, ...props }: DetailPeekProps) {
  const compact = useResponsiveMdQuery();
  return (
    <Drawer
      {...props}
      position="right"
      size={compact ? "100%" : "lg"}
      withOverlay={compact}
      trapFocus={compact}
      lockScroll={compact}
      returnFocus={false}
      title={
        actions ? (
          <Group justify="space-between" gap="xs" wrap="nowrap" w="100%">
            <MyoxusText
              component="span"
              lineClamp={2}
              typographySlot="card-title"
            >
              {title}
            </MyoxusText>
            {actions}
          </Group>
        ) : (
          title
        )
      }
      data-myoxus-ui-role="detail-peek"
    />
  );
}
