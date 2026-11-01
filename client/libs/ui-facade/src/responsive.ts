// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** Mantine-owned responsive hooks shared by Facade layout modules. */
import { useMantineTheme } from "@mantine/core";
import { useElementSize, useMediaQuery, useViewportSize } from "@mantine/hooks";
import { useCallback } from "react";

export function resolveCssVarLengthForMediaQuery(value: string) {
  const trimmedValue = value.trim();
  const varReference = trimmedValue.match(
    /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)$/,
  );

  if (!varReference || typeof window === "undefined") {
    return trimmedValue;
  }

  const [, variableName, fallback] = varReference;
  if (!variableName) return trimmedValue;
  const resolvedValue = getComputedStyle(document.documentElement)
    .getPropertyValue(variableName)
    .trim();

  return resolvedValue || fallback?.trim() || trimmedValue;
}

export function maxWidthQueryForBreakpoint(breakpoint: string) {
  return `(max-width: ${resolveCssVarLengthForMediaQuery(breakpoint)})`;
}

export function useResponsiveQuery(query: string, initialValue = false) {
  const mediaQueryMatch = useMediaQuery(query, undefined, {
    getInitialValueInEffect: false,
  });
  const viewportSize = useViewportSize();

  // `useViewportSize` is a Mantine-owned resize subscription. Reading the
  // current MediaQueryList during that render keeps product chrome correct
  // after browser resizes and Playwright viewport changes without local
  // breakpoint strings in product modules.
  if (typeof window === "undefined" || !("matchMedia" in window)) {
    return mediaQueryMatch || initialValue;
  }

  void viewportSize;

  try {
    return window.matchMedia(query).matches;
  } catch {
    return mediaQueryMatch || initialValue;
  }
}

/**
 * Shared narrow-viewport query for product chrome. It reads the active Mantine
 * theme breakpoint so route code does not hard-code local media-query values.
 */
export function useResponsiveSmQuery(initialValue = false) {
  const theme = useMantineTheme();
  return useResponsiveQuery(
    maxWidthQueryForBreakpoint(theme.breakpoints.sm),
    initialValue,
  );
}

export function useResponsiveMdQuery(initialValue = false) {
  const theme = useMantineTheme();
  return useResponsiveQuery(
    maxWidthQueryForBreakpoint(theme.breakpoints.md),
    initialValue,
  );
}

export function useResponsiveLgQuery(initialValue = false) {
  const theme = useMantineTheme();
  return useResponsiveQuery(
    maxWidthQueryForBreakpoint(theme.breakpoints.lg),
    initialValue,
  );
}

export interface ResponsiveElementSize<T extends HTMLElement = HTMLDivElement> {
  ref: (node: T | null) => void;
  width: number;
  height: number;
}

export function useResponsiveElementSize<
  T extends HTMLElement = HTMLDivElement,
>(options?: ResizeObserverOptions): ResponsiveElementSize<T> {
  const { ref, width, height } = useElementSize<T>(options);
  const stableRef = useCallback(
    (node: T | null) => {
      void ref(node);
    },
    [ref],
  );

  return { ref: stableRef, width, height };
}
