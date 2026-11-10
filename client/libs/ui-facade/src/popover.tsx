// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PopoverProps as MantineCorePopoverProps,
  Popover as MantinePopover,
} from "@mantine/core";
import {
  forwardRef,
  Children,
  isValidElement,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import type { MenuContentOptions } from "./menu";
import { type RoleBoxProps } from "./helpers/ui-role";
import { useIsInsideModal } from "./modal";

const pendingPopoverLimits = new WeakMap<
  HTMLElement,
  { height: number; width: number }
>();
export const popoverViewportMiddlewares = {
  flip: true,
  inline: false,
  shift: true,
  size: {
    // Match Mantine's native shift padding (use-popover) so a full-width
    // dropdown fits within the same clipping boundary, not five pixels beyond it.
    padding: 5,
    apply({ availableHeight, availableWidth, elements }) {
      const element = elements.floating;
      const pending = pendingPopoverLimits.has(element);
      pendingPopoverLimits.set(element, {
        height: availableHeight,
        width: availableWidth,
      });
      if (pending) return;
      // Modal scroll-lock restoration can change the available height during
      // Floating's ResizeObserver delivery. Resize its ScrollArea next frame,
      // using the latest limits, rather than triggering an undelivered loop.
      requestAnimationFrame(() => {
        const limits = pendingPopoverLimits.get(element)!;
        pendingPopoverLimits.delete(element);
        if (!element.isConnected) return;
        element.style.setProperty(
          "--myoxus-popover-available-height",
          `${limits.height}px`,
        );
        element.style.maxHeight = `${limits.height}px`;
        element.style.maxWidth = `${limits.width}px`;
      });
    },
  },
} satisfies MantineCorePopoverProps["middlewares"];

export function Popover({
  children,
  fitViewport,
  floatingStrategy,
  opened,
  open,
  onChange,
  onOpenChange,
  onExitTransitionEnd,
  width,
  contentMeasure,
  position = "bottom",
  content,
  contentOptions,
  returnFocus,
  trapFocus,
  withArrow,
  closeOnEscape,
  closeOnClickOutside,
  withinPortal,
  zIndex,
}: PropsWithChildren<{
  opened?: boolean;
  open?: boolean;
  fitViewport?: boolean;
  floatingStrategy?: MantineCorePopoverProps["floatingStrategy"];
  onChange?: (opened: boolean) => void;
  onOpenChange?: (opened: boolean) => void;
  /** Run after the native dropdown releases its focus trap. */
  onExitTransitionEnd?: () => void;
  width?: number | string;
  /** Literal document text uses half the themed document column; native size middleware still clips it. */
  contentMeasure?: "reading";
  position?: MantineCorePopoverProps["position"];
  content?: ReactNode;
  contentOptions?: MenuContentOptions;
  returnFocus?: boolean;
  trapFocus?: boolean;
  withArrow?: boolean;
  closeOnEscape?: boolean;
  closeOnClickOutside?: boolean;
  /** Keep measured controls under their DOM owner when required (for example
   * canvas handles). Omitted preserves native modal-aware portal ownership. */
  withinPortal?: boolean;
  zIndex?: string | number;
}>) {
  // Keep modal overlays in its focus/layer owner; fixed positioning escapes
  // scroll-container clipping without introducing a competing portal layer.
  const insideModal = useIsInsideModal();
  const isLegacyShorthand = content !== undefined;
  const declaredTarget = isLegacyShorthand
    ? children
    : Children.toArray(children).find(
        (child) =>
          isValidElement<PropsWithChildren>(child) &&
          child.type === PopoverTarget,
      );
  const target =
    !isLegacyShorthand && isValidElement<PropsWithChildren>(declaredTarget)
      ? declaredTarget.props.children
      : declaredTarget;
  // Mantine forwards root data attributes onto its target. Preserve an object's
  // semantic role so opening a popover cannot erase renderer geometry selectors.
  const targetRole = isValidElement<{ "data-myoxus-ui-role"?: string }>(target)
    ? target.props["data-myoxus-ui-role"]
    : undefined;
  return (
    <MantinePopover
      withinPortal={withinPortal ?? !insideModal}
      opened={opened ?? open}
      onChange={(nextOpened) => {
        onChange?.(nextOpened);
        onOpenChange?.(nextOpened);
      }}
      onExitTransitionEnd={onExitTransitionEnd}
      width={
        width ??
        (contentMeasure === "reading"
          ? "calc(var(--myoxus-editor-width) / 2)"
          : undefined)
      }
      position={position}
      floatingStrategy={floatingStrategy ?? (insideModal ? "fixed" : undefined)}
      middlewares={
        (fitViewport ?? insideModal) ? popoverViewportMiddlewares : undefined
      }
      returnFocus={returnFocus}
      trapFocus={trapFocus}
      withArrow={withArrow}
      closeOnEscape={closeOnEscape}
      closeOnClickOutside={closeOnClickOutside}
      zIndex={zIndex}
      data-myoxus-ui-role={targetRole ?? "popover"}
    >
      {isLegacyShorthand ? (
        <>
          <MantinePopover.Target>{children}</MantinePopover.Target>
          <MantinePopover.Dropdown
            className={contentOptions?.className}
            style={contentOptions?.style}
            data-myoxus-ui-role="popover-content"
          >
            {content}
          </MantinePopover.Dropdown>
        </>
      ) : (
        children
      )}
    </MantinePopover>
  );
}

export function PopoverTarget({ children }: PropsWithChildren) {
  return <MantinePopover.Target>{children}</MantinePopover.Target>;
}

export const PopoverContent = forwardRef<HTMLDivElement, RoleBoxProps>(
  function PopoverContent({ children, className, style, ...props }, ref) {
    return (
      <MantinePopover.Dropdown
        {...props}
        ref={ref}
        className={className}
        style={style}
        data-myoxus-ui-role="popover-content"
      >
        {children}
      </MantinePopover.Dropdown>
    );
  },
);
