// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  forwardRef,
  type ButtonHTMLAttributes,
  type Ref,
  type CSSProperties,
  useEffect,
  useRef,
} from "react";
import { joinClassName } from "../helpers/class-name";
import {
  UnstyledButton as MantineUnstyledButton,
  Box,
  ScrollArea,
  Group,
  ActionIcon,
} from "@mantine/core";
import { repeatCssLength, withUnit } from "../css-utils";
import { type IconButtonProps, IconButton } from "../button";

// Electron exposes no theme token for macOS traffic-light hit targets. Keep the
// native window chrome reserve isolated here instead of leaking it into product
// layout code.
const MACOS_TRAFFIC_LIGHT_INLINE_RESERVE = "70px";

const APP_TAB_STRIP_CLASS_NAMES = {
  root: "myoxus-app-tab-strip",
  leading: "myoxus-app-tab-strip__leading",
  list: "myoxus-app-tab-strip__list",
  listContent: "myoxus-app-tab-strip__list-content",
  divider: "myoxus-app-tab-strip__divider",
  tabSlot: "myoxus-app-tab-strip__tab-slot",
  tab: "myoxus-app-tab-strip__tab",
  viewButton: "myoxus-app-tab-strip__view-button",
  viewIcon: "myoxus-app-tab-strip__view-icon",
  viewLabel: "myoxus-app-tab-strip__view-label",
  closeSlot: "myoxus-app-tab-strip__close-slot",
  closeButton: "myoxus-app-tab-strip__close-button",
  spacer: "myoxus-app-tab-strip__spacer",
  actionButton: "myoxus-app-tab-strip__action-button",
  windowsControlsPlaceholder:
    "myoxus-app-tab-strip__windows-controls-placeholder",
  dropIndicator: "myoxus-app-tab-strip__drop-indicator",
} as const;

const APP_WINDOW_CONTROLS_CLASS_NAMES = {
  root: "myoxus-app-window-controls",
  button: "myoxus-app-window-controls__button",
} as const;

export function AppWindowControlsRoot({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div
      {...props}
      className={joinClassName(APP_WINDOW_CONTROLS_CLASS_NAMES.root, className)}
      data-myoxus-ui-role="app-window-controls"
    >
      {children}
    </div>
  );
}

export const AppWindowControlButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    control: "minimize" | "maximize" | "close";
  }
>(function AppWindowControlButton(
  { children, className, control, type = "button", ...props },
  ref,
) {
  return (
    <MantineUnstyledButton
      {...props}
      ref={ref}
      component="button"
      type={type}
      className={joinClassName(
        APP_WINDOW_CONTROLS_CLASS_NAMES.button,
        className,
      )}
      data-window-control={control}
      data-myoxus-ui-role={`app-window-control:${control}`}
    >
      {children}
    </MantineUnstyledButton>
  );
});

function appTabStripMaxInlineSize(viewCount: number, pinned: boolean): string {
  const splitViewInlineSize = repeatCssLength(
    `calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) + calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs)))`,
    viewCount,
  );
  const minimumInlineSize = pinned
    ? "var(--mantine-spacing-2xl)"
    : repeatCssLength(
        "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        5,
      );
  return `max(${splitViewInlineSize}, ${minimumInlineSize})`;
}

export const AppTabStripRoot = forwardRef(function AppTabStripRoot(
  {
    children,
    className,
    mode = "app",
    windows = false,
    ...props
  }: PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
      mode?: "app" | "shell";
      windows?: boolean;
    }
  >,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.root, className)}
      data-mode={mode}
      data-windows={windows ? "true" : "false"}
      data-myoxus-ui-role="app-tab-strip"
    >
      {children}
    </Box>
  );
});

export function AppTabStripLeadingSlot({
  children,
  className,
  expandedInlineSize,
  open = false,
  resizing = false,
  trafficLightReserve = "none",
  style,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    expandedInlineSize?: CSSProperties["width"];
    open?: boolean;
    resizing?: boolean;
    trafficLightReserve?: "none" | "macos";
  }
>) {
  return (
    <Box
      {...props}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.leading, className)}
      data-open={open ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      data-myoxus-ui-role="app-tab-strip-leading"
      style={
        {
          ...style,
          "--myoxus-app-tab-strip-expanded-inline-size":
            expandedInlineSize === undefined
              ? undefined
              : withUnit(expandedInlineSize, "px"),
          "--myoxus-app-tab-strip-traffic-light-offset":
            trafficLightReserve === "macos"
              ? MACOS_TRAFFIC_LIGHT_INLINE_RESERVE
              : undefined,
        } as CSSProperties
      }
    >
      {children}
    </Box>
  );
}

export const AppTabStripList = forwardRef(function AppTabStripList(
  {
    children,
    className,
    ...props
  }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <ScrollArea
      {...props}
      ref={ref}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.list, className)}
      data-myoxus-ui-role="app-tab-strip-list"
      flex="0 1 auto"
      h="100%"
      miw={0}
      scrollbars="x"
      type="auto"
      styles={{ content: { height: "100%" } }}
    >
      {/* Reserve the half-gap insertion markers at both scroll boundaries. */}
      <Group
        className={APP_TAB_STRIP_CLASS_NAMES.listContent}
        gap="xs"
        px="xs"
        w="max-content"
        wrap="nowrap"
      >
        {children}
      </Group>
    </ScrollArea>
  );
});

export function AppTabStripDivider({
  orientation = "split-view",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  orientation?: "pinned" | "split-view";
}) {
  return (
    <Box
      {...props}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.divider, className)}
      data-orientation={orientation}
      data-myoxus-ui-role="app-tab-strip-divider"
    />
  );
}

export const AppTabStripTabSlot = forwardRef(function AppTabStripTabSlot(
  {
    children,
    className,
    ...props
  }: PropsWithChildren<HTMLAttributes<HTMLDivElement>>,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.tabSlot, className)}
      data-myoxus-ui-role="app-tab-strip-tab-slot"
      flex="0 0 auto"
    >
      {children}
    </Box>
  );
});

export function AppTabStripTab({
  active = false,
  children,
  className,
  pinned = false,
  style,
  viewCount = 1,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    active?: boolean;
    pinned?: boolean;
    viewCount?: number;
  }
>) {
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tab = tabRef.current;
    if (!active || !tab) return;
    const reveal = () =>
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();

    // Sidebar transitions and native window resizing change the rail without
    // changing tab selection. Observe its geometry to keep the whole active
    // tab, including the close control and insertion gutter, in view.
    const rail = tab.closest('[data-myoxus-ui-role="app-tab-strip-list"]');
    if (!rail) return;
    const observer = new ResizeObserver(reveal);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [active, pinned, viewCount]);

  return (
    <Box
      {...props}
      ref={tabRef}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.tab, className)}
      data-active={active ? "true" : "false"}
      data-pinned={pinned ? "true" : undefined}
      data-myoxus-ui-role="app-tab-strip-tab"
      style={
        {
          ...style,
          "--myoxus-app-tab-strip-tab-max-inline-size":
            appTabStripMaxInlineSize(viewCount, pinned),
        } as CSSProperties
      }
    >
      {children}
    </Box>
  );
}

export const AppTabStripViewButton = forwardRef(function AppTabStripViewButton(
  {
    active = false,
    children,
    className,
    type = "button",
    ...props
  }: PropsWithChildren<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      active?: boolean;
    }
  >,
  ref: Ref<HTMLButtonElement>,
) {
  return (
    <MantineUnstyledButton
      {...props}
      ref={ref}
      component="button"
      type={type}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.viewButton, className)}
      px="sm"
      data-active={active ? "true" : "false"}
      data-myoxus-ui-role="app-tab-strip-view-button"
    >
      {children}
    </MantineUnstyledButton>
  );
});

export function AppTabStripViewIcon({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Box
      {...props}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.viewIcon, className)}
      data-myoxus-ui-role="app-tab-strip-view-icon"
    >
      {children}
    </Box>
  );
}

export function AppTabStripViewLabel({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Box
      {...props}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.viewLabel, className)}
      data-myoxus-ui-role="app-tab-strip-view-label"
    >
      {children}
    </Box>
  );
}

export function AppTabStripCloseSlot({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Box
      {...props}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.closeSlot, className)}
      data-myoxus-ui-role="app-tab-strip-close-slot"
    >
      {children}
    </Box>
  );
}

export const AppTabStripCloseButton = forwardRef(
  function AppTabStripCloseButton(
    {
      children,
      className,
      type = "button",
      ...props
    }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>,
    ref: Ref<HTMLButtonElement>,
  ) {
    return (
      <ActionIcon
        {...props}
        ref={ref}
        type={type}
        variant="subtle"
        size={"var(--mantine-spacing-lg)"}
        className={joinClassName(
          APP_TAB_STRIP_CLASS_NAMES.closeButton,
          className,
        )}
        data-myoxus-ui-role="app-tab-strip-close-button"
      >
        {children}
      </ActionIcon>
    );
  },
);

export const AppTabStripSpacer = forwardRef(function AppTabStripSpacer(
  {
    children,
    className,
    draggedOver = false,
    ...props
  }: PropsWithChildren<
    HTMLAttributes<HTMLDivElement> & {
      draggedOver?: boolean;
    }
  >,
  ref: Ref<HTMLDivElement>,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(APP_TAB_STRIP_CLASS_NAMES.spacer, className)}
      data-dragged-over={draggedOver ? "true" : undefined}
      data-myoxus-ui-role="app-tab-strip-spacer"
    >
      {children}
    </Box>
  );
});

export const AppTabStripActionButton = forwardRef(
  function AppTabStripActionButton(
    { className, size = "default", ...props }: IconButtonProps,
    ref: Ref<HTMLButtonElement>,
  ) {
    return (
      <IconButton
        {...props}
        ref={ref}
        size={size}
        className={joinClassName(
          APP_TAB_STRIP_CLASS_NAMES.actionButton,
          className,
        )}
        data-myoxus-ui-role="app-tab-strip-action-button"
      />
    );
  },
);

export function AppTabStripWindowsControlsPlaceholder({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <Box
      {...props}
      className={joinClassName(
        APP_TAB_STRIP_CLASS_NAMES.windowsControlsPlaceholder,
        className,
      )}
      data-myoxus-ui-role="app-tab-strip-windows-controls-placeholder"
    />
  );
}

export function AppTabStripDropIndicator({
  className,
  edge,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  edge?: "left" | "right" | "top" | "bottom" | null;
}) {
  return (
    <Box
      {...props}
      className={joinClassName(
        APP_TAB_STRIP_CLASS_NAMES.dropIndicator,
        className,
      )}
      data-edge={edge ?? undefined}
      data-myoxus-ui-role="app-tab-strip-drop-indicator"
    />
  );
}
