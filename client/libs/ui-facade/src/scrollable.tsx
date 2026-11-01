// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Mantine-backed scrolling primitives, including the narrow native viewport
 * required by virtualizers that cannot use Mantine's split root/viewport DOM.
 */
import { Box, ScrollArea } from "@mantine/core";
import {
  type ComponentProps,
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
} from "react";

export const Scrollable = {
  Root: forwardRef<
    HTMLDivElement,
    HTMLAttributes<HTMLDivElement> & {
      display?: CSSProperties["display"];
      flex?: CSSProperties["flex"];
      flexDirection?: CSSProperties["flexDirection"];
      h?: CSSProperties["height"];
      minHeight?: CSSProperties["minHeight"];
      "data-myoxus-ui-role"?: string;
    }
  >(function Root(
    { display, flex, flexDirection, h, minHeight, style, ...props },
    ref,
  ) {
    const uiRole =
      (props as Record<string, unknown>)["data-myoxus-ui-role"] ??
      "settings-scroll-root";
    return (
      <Box
        {...props}
        ref={ref}
        w="100%"
        miw={0}
        data-myoxus-ui-role={uiRole as string}
        style={{
          display,
          flex,
          flexDirection,
          height: h,
          minHeight,
          ...style,
        }}
      />
    );
  }),
  Viewport: forwardRef<
    HTMLDivElement,
    HTMLAttributes<HTMLDivElement> & {
      autosize?: boolean;
      bg?: ComponentProps<typeof ScrollArea>["bg"];
      fill?: boolean;
      maxHeight?:
        CSSProperties["maxHeight"] | "floating" | "popover" | "selector";
      offsetScrollbars?: ComponentProps<typeof ScrollArea>["offsetScrollbars"];
      padding?: CSSProperties["padding"];
      scrollbars?: ComponentProps<typeof ScrollArea>["scrollbars"];
      scrollbarVisibility?: ComponentProps<typeof ScrollArea>["type"];
      "data-myoxus-ui-role"?: string;
    }
  >(function Viewport(
    {
      autosize = false,
      fill = false,
      maxHeight,
      offsetScrollbars,
      padding,
      scrollbars,
      scrollbarVisibility = "auto",
      style,
      onScroll,
      onWheel,
      tabIndex: explicitTabIndex,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      ...props
    },
    ref,
  ) {
    // Mantine ScrollArea provides the actual scrollbars, but consumers expect a
    // Radix-like Root/Viewport shape. Keep that compatibility here.
    const uiRole =
      (props as Record<string, unknown>)["data-myoxus-ui-role"] ??
      "settings-scroll-viewport";
    const tabIndex = explicitTabIndex ?? 0;
    const viewportProps = {
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      onScroll,
      onWheel,
      tabIndex,
    };
    const sharedProps = {
      ...props,
      viewportRef: ref,
      viewportProps,
      w: "100%",
      miw: 0,
      style: {
        flex: fill ? 1 : undefined,
        height: autosize ? undefined : "100%",
        minHeight: 0,
        padding,
        ...style,
      },
      offsetScrollbars,
      scrollbars,
      // An outer Mantine Autosize sets min-content on descendant scroll content.
      // Keep nested vertical-only content within its own viewport instead.
      styles:
        scrollbars === "y" ? { content: { minWidth: "100%" } } : undefined,
      type: scrollbarVisibility,
      "data-myoxus-ui-role": uiRole as string,
    };
    if (autosize) {
      return (
        <ScrollArea.Autosize
          {...sharedProps}
          mah={
            maxHeight === "floating"
              ? "calc(var(--myoxus-popover-available-height, 100dvh) - var(--mantine-spacing-md) * 2)"
              : maxHeight === "selector"
                ? "400px"
                : maxHeight === "popover"
                  ? "calc(100dvh - var(--mantine-spacing-xl) * 8)"
                  : maxHeight
          }
        />
      );
    }
    return <ScrollArea {...sharedProps} />;
  }),
  // Virtualizers such as react-virtuoso require scroll props, ref and children
  // on the same DOM node. Mantine ScrollArea intentionally splits those across
  // root and viewport, so expose a native facade viewport for that integration.
  VirtualizedViewport: forwardRef<
    HTMLDivElement,
    HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
  >(function VirtualizedViewport({ style, ...props }, ref) {
    const uiRole =
      (props as Record<string, unknown>)["data-myoxus-ui-role"] ??
      "virtualized-scroll-viewport";

    return (
      <Box
        {...props}
        ref={ref}
        data-myoxus-ui-role={uiRole as string}
        style={{
          height: "100%",
          minHeight: 0,
          overflowY: "auto",
          position: "relative",
          ...style,
        }}
      />
    );
  }),
  Scrollbar: function Scrollbar(
    _props: HTMLAttributes<HTMLDivElement> & { orientation?: string },
  ) {
    return null;
  },
};
