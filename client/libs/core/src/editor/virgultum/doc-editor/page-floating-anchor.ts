// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { autoUpdate } from "@floating-ui/dom";
import { useClickOutside } from "@myoxus/ui-facade";
import { useCallback, useLayoutEffect, useRef } from "react";

export type FloatingRectSource =
  | HTMLElement
  | { contextElement?: Element; getBoundingClientRect: () => DOMRect };

/**
 * Synchronize a fixed floating anchor span with a live reference element or
 * virtual rect source until the returned disposer runs.
 */
export function bindFloatingAnchor(
  reference: FloatingRectSource,
  anchor: HTMLElement,
  options?: {
    minWidth?: number;
    minHeight?: number;
    onDetached?: () => void;
  },
): () => void {
  const minWidth = options?.minWidth ?? 0;
  const minHeight = options?.minHeight ?? 0;
  const sync = () => {
    if (reference instanceof HTMLElement && !reference.isConnected) {
      options?.onDetached?.();
      return;
    }
    const rect = reference.getBoundingClientRect();
    Object.assign(anchor.style, {
      position: "fixed",
      pointerEvents: "none",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(rect.width, minWidth)}px`,
      height: `${Math.max(rect.height, minHeight)}px`,
    });
  };
  return autoUpdate(reference, anchor, sync);
}

/**
 * Shared floating-anchor and outside-click controller for Page overlays
 * (toolbars, inline popups, equation editors, link editors, table menus).
 */
export function usePageFloatingAnchor({
  active,
  reference,
  anchor,
  floating,
  onDismiss,
  ignoreSelector = '[data-testid="selection-toolbar"],[data-range-sync-exclude],[role="menu"],[role="dialog"]',
  deps = [],
}: {
  active: boolean;
  reference: HTMLElement | null;
  anchor: HTMLElement | null;
  floating?: HTMLElement | null;
  onDismiss?: () => void;
  ignoreSelector?: string;
  deps?: readonly unknown[];
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!active || !reference || !anchor) return;
    return bindFloatingAnchor(reference, anchor, {
      onDetached: () => onDismissRef.current?.(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reference, anchor, ...deps]);

  const handleOutside = useCallback(
    (event: Event) => {
      if (!active || !onDismissRef.current) return;
      const target = event.target;
      if (target instanceof Node) {
        if (reference?.contains(target) || floating?.contains(target)) return;
        if (
          target instanceof Element &&
          ignoreSelector &&
          target.closest(ignoreSelector)
        )
          return;
      }
      onDismissRef.current();
    },
    [active, reference, floating, ignoreSelector],
  );

  useClickOutside(
    handleOutside,
    ["pointerdown"],
    [reference, floating ?? null],
  );
}
