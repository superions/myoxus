// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ResizePanelProps, ResizePanel } from "./resize-panel";
import {
  type HTMLAttributes,
  type ReactNode,
  useRef,
  type CSSProperties,
  useEffect,
} from "react";
import {
  useMantineTheme,
  Stack,
  Drawer as MantineDrawer,
  Box,
} from "@mantine/core";
import { useViewportSize, useMediaQuery } from "@mantine/hooks";
import {
  maxWidthQueryForBreakpoint,
  resolveCssVarLengthForMediaQuery,
} from "./responsive";
import { cssVar } from "@myoxus/theme";
import { cssLengthToPx } from "./css-utils";

export type ResponsiveSidePanelSide = "left" | "right";

export type ResponsiveSidePanelResizeProps = Omit<
  ResizePanelProps,
  | "children"
  | "className"
  | "maxWidth"
  | "minWidth"
  | "open"
  | "onOpen"
  | "style"
  | "unmountOnExit"
  | "width"
> &
  Partial<Pick<ResizePanelProps, "maxWidth" | "minWidth" | "width">>;

export interface ResponsiveSidePanelProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onResize"
> {
  opened: boolean;
  onOpenChange: (open: boolean) => void;
  side: ResponsiveSidePanelSide;
  breakpoint?: string;
  drawerOnNarrow?: boolean;
  drawerSize?: number | string;
  drawerTitle?: ReactNode;
  withDrawerCloseButton?: boolean;
  closeOnFirstNarrowOpen?: boolean;
  desktopResize?: ResponsiveSidePanelResizeProps;
  /** Uses the server-projected navigation surface and its content divider. */
  surface?: "default" | "navigation";
}

export function ResponsiveSidePanel({
  opened,
  onOpenChange,
  side,
  breakpoint,
  drawerOnNarrow = true,
  drawerSize = "min(88vw, 360px)",
  drawerTitle,
  withDrawerCloseButton = false,
  closeOnFirstNarrowOpen,
  desktopResize,
  surface = "default",
  children,
  className,
  style,
  ...rest
}: ResponsiveSidePanelProps) {
  // The side panel becomes a Drawer only at the facade boundary. Product routes
  // should not own separate mobile drawer implementations for the same panel.
  const theme = useMantineTheme();
  const viewportSize = useViewportSize();
  const breakpointQuery =
    breakpoint ??
    maxWidthQueryForBreakpoint(
      side === "right" ? theme.breakpoints.md : theme.breakpoints.sm,
    );
  const isNarrowViewport = useMediaQuery(breakpointQuery, undefined, {
    getInitialValueInEffect: false,
  });
  const useDrawer = drawerOnNarrow && isNarrowViewport;
  const firstNarrowCloseAppliedRef = useRef(false);
  // Persistent left navigation is commonly open on desktop; the facade
  // suppresses that stored state once when it becomes a drawer so mobile starts
  // content-first without product-side breakpoint heuristics.
  const shouldCloseOnFirstNarrowOpen =
    closeOnFirstNarrowOpen ?? side === "left";
  const shouldForceClosedOnNarrow =
    useDrawer &&
    shouldCloseOnFirstNarrowOpen &&
    opened &&
    !firstNarrowCloseAppliedRef.current;
  const effectiveOpened = shouldForceClosedOnNarrow ? false : opened;
  const navigationSurface = surface === "navigation";
  const surfaceBackground = navigationSurface
    ? cssVar("--myoxus-selfhost-sidebar-bg")
    : undefined;
  const surfaceBorder = navigationSurface
    ? `calc(var(--mantine-scale) * 1px) solid ${cssVar("borderColor")}`
    : undefined;
  const surfaceStyle: CSSProperties = {
    background: surfaceBackground,
    borderInlineEnd: side === "left" ? surfaceBorder : undefined,
    borderInlineStart: side === "right" ? surfaceBorder : undefined,
    ...style,
  };

  useEffect(() => {
    if (shouldForceClosedOnNarrow) {
      onOpenChange(false);
    }

    if (!useDrawer) {
      firstNarrowCloseAppliedRef.current = false;
    } else if (!opened) {
      // A panel that entered narrow mode while already closed has no inherited
      // desktop-open state to suppress. Mark that transition as handled so a
      // later explicit user open is not immediately closed again.
      firstNarrowCloseAppliedRef.current = true;
    }
  }, [onOpenChange, opened, shouldForceClosedOnNarrow, useDrawer]);

  const content = (
    <Stack data-myoxus-ui-role="responsive-side-panel-content" h="100%" mih={0}>
      {children}
    </Stack>
  );

  if (useDrawer) {
    return (
      <MantineDrawer
        opened={effectiveOpened}
        onClose={() => onOpenChange(false)}
        position={side}
        size={drawerSize}
        title={drawerTitle}
        withCloseButton={withDrawerCloseButton}
        styles={{
          body: {
            height: "100%",
            minHeight: 0,
            padding: 0,
          },
          content: {
            background: surfaceBackground ?? cssVar("backgroundPrimaryColor"),
            borderInlineEnd: side === "left" ? surfaceBorder : undefined,
            borderInlineStart: side === "right" ? surfaceBorder : undefined,
            color: cssVar("textPrimaryColor"),
            zIndex: `calc(${cssVar("zIndexModal")} + 2)`,
            ...style,
          },
          header: {
            background: surfaceBackground ?? cssVar("backgroundPrimaryColor"),
          },
        }}
        data-myoxus-ui-role="responsive-side-panel-drawer"
      >
        <Box
          {...rest}
          h="100%"
          data-open={effectiveOpened}
          data-side={side}
          data-responsive-mode="drawer"
          data-myoxus-responsive-side-panel="true"
        >
          {content}
        </Box>
      </MantineDrawer>
    );
  }

  if (desktopResize) {
    const rootFontSize =
      typeof window === "undefined"
        ? 16
        : Number.parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          ) || 16;
    const defaultPanelWidth = cssLengthToPx(
      resolveCssVarLengthForMediaQuery(side === "left" ? "15.5rem" : "24rem"),
      rootFontSize,
    );
    const maxPanelWidth = cssLengthToPx(
      resolveCssVarLengthForMediaQuery(
        side === "left" ? theme.breakpoints.xs : theme.breakpoints.lg,
      ),
      rootFontSize,
    );
    const resolvedWidth =
      desktopResize.width && desktopResize.width > 0
        ? desktopResize.width
        : defaultPanelWidth;
    const resolvedMinWidth =
      desktopResize.minWidth ?? Math.min(defaultPanelWidth, resolvedWidth);
    const viewportMaxWidth =
      viewportSize.width > 0
        ? Math.max(resolvedMinWidth, viewportSize.width - defaultPanelWidth)
        : maxPanelWidth;
    const resolvedMaxWidth =
      desktopResize.maxWidth ??
      Math.max(resolvedMinWidth, Math.min(maxPanelWidth, viewportMaxWidth));

    return (
      <ResizePanel
        {...rest}
        {...desktopResize}
        className={className}
        maxWidth={resolvedMaxWidth}
        minWidth={resolvedMinWidth}
        open={opened}
        onOpen={onOpenChange}
        style={surfaceStyle}
        unmountOnExit={false}
        width={resolvedWidth}
        data-open={opened}
        data-side={side}
        data-responsive-mode="desktop-resize"
        data-myoxus-responsive-side-panel="true"
      >
        {content}
      </ResizePanel>
    );
  }

  return (
    <div
      {...rest}
      className={className}
      data-open={opened}
      data-side={side}
      data-responsive-mode="desktop-static"
      data-myoxus-responsive-side-panel="true"
      hidden={!opened}
      style={surfaceStyle}
    >
      {content}
    </div>
  );
}
