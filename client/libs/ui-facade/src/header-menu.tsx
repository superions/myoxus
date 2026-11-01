// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlignJustifyIcon } from "@myoxus/icons/react";
import {
  type ComponentType,
  type ForwardedRef,
  forwardRef,
  type ReactNode,
  type RefAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type HeaderMenuDataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

export type HeaderMenuButtonProps = HeaderMenuDataAttributes & {
  /** Localized accessible name shared by the tooltip and icon-only trigger. */
  ariaLabel: string;
  /** Page-owned MenuPanel/MenuItem composition. */
  items: ReactNode;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function assignForwardedRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

type HeaderMenuPrimitives = {
  IconButton: ComponentType<
    HeaderMenuDataAttributes &
      RefAttributes<HTMLButtonElement> & {
        "aria-label": string;
        "data-myoxus-ui-role": string;
        disabled?: boolean;
        icon: ReactNode;
        tooltip: ReactNode;
        tooltipOptions?: { opened?: boolean };
      }
  >;
  Menu: ComponentType<{
    children: ReactNode;
    items: ReactNode;
    contentOptions?: {
      align?: "start" | "center" | "end";
      panelWidth?: "comfortable";
      side?: "top" | "right" | "bottom" | "left";
    };
    rootOptions?: {
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    };
  }>;
};

/**
 * Canonical desktop Workbench header burger.
 *
 * Product callers own commands and permissions; this Facade role owns the
 * stable Mantine Menu trigger, density, collision behavior and focus return.
 */
export function createHeaderMenuButton({
  IconButton,
  Menu,
}: HeaderMenuPrimitives) {
  return forwardRef(function HeaderMenuButton(
    {
      ariaLabel,
      disabled,
      items,
      onOpenChange,
      open,
      ...dataAttributes
    }: HeaderMenuButtonProps,
    ref: ForwardedRef<HTMLButtonElement>,
  ) {
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const resolvedOpen = open ?? uncontrolledOpen;
    const wasOpenRef = useRef(resolvedOpen);

    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        assignForwardedRef(ref, node);
      },
      [ref],
    );

    const handleOpenChange = useCallback(
      (nextOpen: boolean) => {
        setUncontrolledOpen(nextOpen);
        onOpenChange?.(nextOpen);
      },
      [onOpenChange],
    );

    useEffect(() => {
      const wasOpen = wasOpenRef.current;
      wasOpenRef.current = resolvedOpen;
      if (!wasOpen || resolvedOpen) return;

      // Mantine restores focus for keyboard dismissal in the browser. The
      // deferred fallback also covers pointer selection and outside dismissal,
      // but deliberately yields to a Modal opened by the selected command.
      const timer = globalThis.setTimeout(() => {
        const activeElement = globalThis.document?.activeElement;
        if (activeElement?.closest('[role="dialog"]')) return;
        triggerRef.current?.focus();
      }, 0);
      return () => globalThis.clearTimeout(timer);
    }, [resolvedOpen]);

    return (
      <Menu
        items={items}
        rootOptions={{ open: resolvedOpen, onOpenChange: handleOpenChange }}
        contentOptions={{
          align: "end",
          panelWidth: "comfortable",
          side: "bottom",
        }}
      >
        <IconButton
          {...dataAttributes}
          ref={setTriggerRef}
          aria-label={ariaLabel}
          disabled={disabled}
          icon={<AlignJustifyIcon />}
          tooltip={ariaLabel}
          tooltipOptions={{ opened: resolvedOpen ? false : undefined }}
          data-myoxus-ui-role="workbench-header-menu"
        />
      </Menu>
    );
  });
}
