// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import {
  forwardRef,
  type PropsWithChildren,
  type CSSProperties,
  type HTMLAttributes,
  type ElementType,
  type Ref,
  type ReactNode,
} from "react";
import { SafeArea, type SafeAreaProps } from "./safe-area";
import { cssVar } from "@myoxus/theme";
import { Box, Stack, Group } from "@mantine/core";
import { Skeleton } from "./feedback";

export type MobileHomeHeaderRootProps = RoleBoxProps & {
  fixed?: boolean;
  dense?: boolean;
};

// Home uses a two-part mobile header: in-flow workspace/search content plus a
// fixed dense bar. Keep that shared chrome here instead of route CSS.
export const MobileHomeHeaderRoot = forwardRef<
  HTMLDivElement,
  MobileHomeHeaderRootProps
>(function MobileHomeHeaderRoot(
  {
    children,
    fixed = false,
    dense = false,
    style,
    "data-myoxus-ui-role": uiRole = "mobile-home-header",
    ...props
  },
  ref,
) {
  return (
    <SafeArea
      {...props}
      ref={ref}
      top
      data-fixed={fixed ? "true" : undefined}
      data-dense={dense ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
      style={{
        backgroundColor:
          fixed && dense ? cssVar("backgroundSecondaryColor") : "transparent",
        insetBlockStart: fixed ? 0 : undefined,
        insetInline: fixed ? 0 : undefined,
        position: fixed ? "fixed" : undefined,
        inlineSize: "100%",
        zIndex: fixed ? "20" : undefined,
        ...style,
      }}
    >
      {children}
    </SafeArea>
  );
});

export function MobileHomeHeaderSpacer({
  style,
  "data-myoxus-ui-role": uiRole = "mobile-home-header-spacer",
  ...props
}: Omit<RoleBoxProps, "children">) {
  return (
    <Box
      {...props}
      aria-hidden="true"
      data-myoxus-ui-role={uiRole}
      style={{
        height: "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        ...style,
      }}
    />
  );
}

export type MobileAppTabsRootProps = PropsWithChildren<
  Omit<SafeAreaProps, "bottom" | "bottomOffset" | "top" | "topOffset"> & {
    background?: CSSProperties["backgroundColor"];
    fixed?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>;

/**
 * Mobile bottom navigation shell. Keep the safe-area, fixed positioning and
 * active tab chrome centralized here so mobile routes do not reintroduce
 * hand-written responsive tab bars.
 */
export const MobileAppTabsRoot = forwardRef<
  HTMLDivElement,
  MobileAppTabsRootProps
>(function MobileAppTabsRoot(
  {
    background,
    children,
    fixed = true,
    hidden,
    style,
    "data-myoxus-ui-role": uiRole = "mobile-app-tabs",
    ...props
  },
  ref,
) {
  return (
    <SafeArea
      {...props}
      ref={ref}
      bottom
      aria-hidden={hidden ? "true" : undefined}
      data-fixed={fixed ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      style={{
        backgroundColor: background ?? cssVar("backgroundSecondaryColor"),
        borderBlockStart: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        inlineSize: "100%",
        insetBlockEnd: fixed ? 0 : undefined,
        position: fixed ? "fixed" : undefined,
        visibility: hidden ? "hidden" : undefined,
        zIndex: fixed ? "20" : undefined,
        ...style,
      }}
    >
      {children}
    </SafeArea>
  );
});

export function MobileAppTabsList({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-app-tabs-list",
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      component="nav"
      role="tablist"
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        display: "flex",
        gap: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        justifyContent: "space-between",
        minBlockSize: `calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) + var(--mantine-spacing-md))`,
        paddingBlock:
          "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        paddingInline: "var(--mantine-spacing-sm)",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export type MobileAppTabsItemProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> & {
    active?: boolean;
    component?: ElementType;
    replaceHistory?: boolean;
    to?: unknown;
    "data-myoxus-ui-role"?: string;
  }
>;

export const MobileAppTabsItem = forwardRef<
  HTMLElement,
  MobileAppTabsItemProps
>(function MobileAppTabsItem(
  {
    active = false,
    children,
    component,
    style,
    "data-myoxus-ui-role": uiRole = "mobile-app-tabs-item",
    ...props
  },
  ref,
) {
  const Component = component ?? "button";
  const buttonProps = Component === "button" ? { type: "button" as const } : {};

  return (
    <Box
      {...props}
      {...buttonProps}
      ref={ref as Ref<HTMLButtonElement>}
      component={Component as "button"}
      aria-selected={active}
      data-active={active ? "true" : undefined}
      data-myoxus-ui-role={uiRole}
      role={props.role ?? "tab"}
      style={{
        alignItems: "center",
        appearance: Component === "button" ? "none" : undefined,
        backgroundColor: active
          ? cssVar("backgroundSecondaryColor")
          : "transparent",
        border: 0,
        borderRadius: "var(--mantine-radius-xl)",
        color: active ? cssVar("primaryColor") : cssVar("iconColor"),
        cursor: "pointer",
        display: "inline-flex",
        flex: "1 1 0",
        fontSize: "var(--mantine-spacing-xl)",
        inlineSize: 0,
        justifyContent: "center",
        lineHeight: "1",
        minBlockSize:
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
        minInlineSize: 0,
        padding: "var(--mantine-spacing-2xs)",
        textDecoration: "none",
        touchAction: "manipulation",
        transition: `background-color 120ms ease, color 120ms ease`,
        ...style,
      }}
    >
      {children}
    </Box>
  );
});

const mobileAppFallbackLineWidths = ["42%", "78%", "62%", "46%"] as const;

function MobileAppFallbackSection({
  "data-myoxus-ui-role": uiRole = "mobile-app-fallback-section",
}: {
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Stack
      gap={"var(--mantine-spacing-md)"}
      data-myoxus-ui-role={uiRole}
      style={{ marginBlockEnd: "var(--mantine-spacing-xl)" }}
    >
      <Box
        data-myoxus-ui-role="mobile-app-fallback-section-title"
        style={{ paddingInline: "var(--mantine-spacing-lg)" }}
      >
        <Skeleton
          variant="rectangular"
          height={"var(--mantine-spacing-xl)"}
          width="32%"
        />
      </Box>
      <Stack
        gap={"var(--mantine-spacing-md)"}
        data-myoxus-ui-role="mobile-app-fallback-section-list"
        style={{ paddingInline: "var(--mantine-spacing-lg)" }}
      >
        {mobileAppFallbackLineWidths.map((width, index) => (
          <Group
            key={`${width}-${index}`}
            align="center"
            gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}
            wrap="nowrap"
            data-myoxus-ui-role="mobile-app-fallback-section-row"
          >
            <Skeleton
              variant="rectangular"
              height={"var(--mantine-spacing-xl)"}
              width={"var(--mantine-spacing-xl)"}
            />
            <Skeleton
              variant="rectangular"
              height={"var(--mantine-spacing-xl)"}
              width={width}
            />
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}

export function MobileAppFallback({
  workspaceSelector,
  "data-myoxus-ui-role": uiRole = "mobile-app-fallback",
}: {
  workspaceSelector?: ReactNode;
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <SafeArea
      top
      bottom
      data-myoxus-ui-role={uiRole}
      style={{
        blockSize: "100dvh",
        overflow: "hidden",
      }}
    >
      <Group
        align="center"
        justify="flex-end"
        gap={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
        data-myoxus-ui-role="mobile-app-fallback-actions"
        style={{
          paddingBlockStart: 0,
          paddingBlockEnd:
            "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
          paddingInline:
            "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
        }}
      >
        <Skeleton
          variant="rectangular"
          height={
            "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
          }
          width={
            "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
          }
        />
        <Skeleton
          variant="rectangular"
          height={
            "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
          }
          width={
            "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))"
          }
        />
      </Group>
      {workspaceSelector ? (
        <Box
          data-myoxus-ui-role="mobile-app-fallback-workspace"
          style={{
            paddingBlock: "var(--mantine-spacing-xs)",
            paddingInline: "var(--mantine-spacing-lg)",
          }}
        >
          {workspaceSelector}
        </Box>
      ) : null}
      <Box
        data-myoxus-ui-role="mobile-app-fallback-search"
        style={{
          paddingBlock: `calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs)) calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))`,
          paddingInline: "var(--mantine-spacing-lg)",
        }}
      >
        <Skeleton
          variant="rectangular"
          height={
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"
          }
        />
      </Box>
      <Box
        data-myoxus-ui-role="mobile-app-fallback-recent-title"
        style={{ paddingInline: "var(--mantine-spacing-lg)" }}
      >
        <Skeleton
          variant="rectangular"
          height={"var(--mantine-spacing-xl)"}
          width="32%"
        />
      </Box>
      <Group
        gap={"var(--mantine-spacing-sm)"}
        wrap="nowrap"
        data-myoxus-ui-role="mobile-app-fallback-recent-rail"
        style={{
          overflow: "hidden",
          paddingBlock: `var(--mantine-spacing-lg) var(--mantine-spacing-xl)`,
          paddingInline: "var(--mantine-spacing-lg)",
        }}
      >
        {["58%", "54%", "50%"].map((width) => (
          <Skeleton
            key={width}
            variant="rectangular"
            height={`calc(calc(var(--mantine-spacing-2xl) * 2) * 3)`}
            width={width}
          />
        ))}
      </Group>
      <MobileAppFallbackSection />
      <MobileAppFallbackSection data-myoxus-ui-role="mobile-app-fallback-section-secondary" />
    </SafeArea>
  );
}

export function MobileHomeHeaderContent({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-home-header-content",
  ...props
}: RoleBoxProps) {
  return (
    <Stack
      {...props}
      gap={"calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))"}
      data-myoxus-ui-role={uiRole}
      style={{
        paddingBlock: `var(--mantine-spacing-xs) calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))`,
        paddingInline: "var(--mantine-spacing-lg)",
        ...style,
      }}
    >
      {children}
    </Stack>
  );
}

export function MobileHomeHeaderFloatingBar({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-home-header-floating-bar",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      align="center"
      gap={"calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"}
      wrap="nowrap"
      data-myoxus-ui-role={uiRole}
      style={{
        paddingBlock: "var(--mantine-spacing-xs)",
        paddingInline: `var(--mantine-spacing-lg) calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))`,
        ...style,
      }}
    >
      {children}
    </Group>
  );
}

export function MobileHomeHeaderFloatingWorkspaceSlot({
  children,
  dense,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-home-header-floating-workspace",
  ...props
}: RoleBoxProps & { dense?: boolean }) {
  return (
    <Box
      {...props}
      data-visible={dense ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        pointerEvents: dense ? "auto" : "none",
        visibility: dense ? "visible" : "hidden",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function MobileHomeHeaderActions({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-home-header-actions",
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      align="center"
      gap={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
      data-myoxus-ui-role={uiRole}
      style={{ flex: "0 0 auto", ...style }}
    >
      {children}
    </Group>
  );
}
