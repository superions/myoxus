// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  forwardRef,
  type ComponentProps,
  type ElementType,
} from "react";
import { Box } from "@mantine/core";
import { type MyoxusTextProps, MyoxusText } from "./typography";
import { Scrollable } from "./scrollable";
import { cssVar } from "@myoxus/theme";
import { SafeArea } from "./safe-area";

type MobileSelectorRoleProps<T extends HTMLElement> = PropsWithChildren<
  HTMLAttributes<T> & {
    "data-myoxus-ui-role"?: string;
  }
>;

export function MobileSelectorRoot({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-root",
  ...props
}: MobileSelectorRoleProps<HTMLDivElement>) {
  return (
    <Box
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function MobileSelectorHeaderTitle({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-header-title",
  ...props
}: MyoxusTextProps & { "data-myoxus-ui-role"?: string }) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "span"}
      fallbackSlot="body-small"
      tone="primary"
      truncate
      typographySlot="nav"
      data-myoxus-ui-role={uiRole}
      style={{
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </MyoxusText>
  );
}

export const MobileSelectorList = forwardRef<
  HTMLUListElement,
  MobileSelectorRoleProps<HTMLUListElement>
>(function MobileSelectorList(
  {
    children,
    style,
    "data-myoxus-ui-role": uiRole = "mobile-selector-list",
    ...props
  },
  ref,
) {
  return (
    <ul
      {...props}
      ref={ref}
      data-myoxus-ui-role={uiRole}
      style={{
        listStyle: "none",
        margin: 0,
        padding: `0 var(--mantine-spacing-xs)`,
        position: "relative",
        ...style,
      }}
    >
      {children}
    </ul>
  );
});

export const MobileSelectorTouchRail = forwardRef<
  HTMLDivElement,
  Omit<MobileSelectorRoleProps<HTMLDivElement>, "children">
>(function MobileSelectorTouchRail(
  {
    style,
    "data-myoxus-ui-role": uiRole = "mobile-selector-touch-rail",
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      aria-hidden="true"
      data-myoxus-ui-role={uiRole}
      style={{
        height: "100%",
        insetBlockStart: 0,
        insetInlineStart: 0,
        position: "absolute",
        width: "var(--mantine-spacing-xl)",
        ...style,
      }}
    />
  );
});

export function MobileSelectorScrollArea({
  flex = "1 1 auto",
  minHeight = 0,
  "data-myoxus-ui-role": uiRole = "mobile-selector-scroll-area",
  ...props
}: ComponentProps<typeof Scrollable.Root>) {
  return (
    <Scrollable.Root
      {...props}
      flex={flex}
      minHeight={minHeight}
      data-myoxus-ui-role={uiRole}
    />
  );
}

export function MobileSelectorScrollViewport({
  "data-myoxus-ui-role": uiRole = "mobile-selector-scroll-viewport",
  ...props
}: ComponentProps<typeof Scrollable.Viewport>) {
  return <Scrollable.Viewport {...props} data-myoxus-ui-role={uiRole} fill />;
}

type MobileSelectorListItemProps = PropsWithChildren<
  HTMLAttributes<HTMLElement> & {
    component?: ElementType;
    href?: string;
    rel?: string;
    target?: string;
    to?: unknown;
    "data-myoxus-ui-role"?: string;
  }
>;

export function MobileSelectorListItem({
  children,
  component,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-list-item",
  ...props
}: MobileSelectorListItemProps) {
  const Component = component ?? "li";
  const isPolymorphicRoot = Component !== "li";
  return (
    <Box
      {...props}
      component={Component as "li"}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        borderBottom: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        color: cssVar("textPrimaryColor"),
        cursor: "pointer",
        display: "flex",
        gap: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        padding: "var(--mantine-spacing-xs)",
        textDecoration: isPolymorphicRoot ? "none" : undefined,
        width: isPolymorphicRoot ? "100%" : undefined,
        ...style,
      }}
    >
      {children}
    </Box>
  );
}

export function MobileSelectorIconSlot({
  children,
  tone = "primary",
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-icon-slot",
  ...props
}: MobileSelectorRoleProps<HTMLDivElement> & {
  tone?: "disabled" | "primary";
}) {
  return (
    <div
      {...props}
      data-tone={tone}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        color:
          tone === "disabled"
            ? cssVar("textDisableColor")
            : cssVar("iconColor"),
        display: "flex",
        flexShrink: 0,
        fontSize: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        height: "var(--mantine-spacing-lg)",
        justifyContent: "center",
        width: "var(--mantine-spacing-lg)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function MobileSelectorItemLabel({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-item-label",
  ...props
}: MyoxusTextProps & { "data-myoxus-ui-role"?: string }) {
  return (
    <MyoxusText
      {...props}
      component={props.component ?? "div"}
      fallbackSlot="body-small"
      tone="primary"
      truncate
      typographySlot="body"
      data-myoxus-ui-role={uiRole}
      style={{
        flex: "1 1 0",
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </MyoxusText>
  );
}

export function MobileSelectorFooter({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-footer",
  ...props
}: MobileSelectorRoleProps<HTMLDivElement>) {
  return (
    <SafeArea
      {...props}
      bottom
      data-myoxus-ui-role={uiRole}
      style={{
        borderTop: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        paddingInline: "var(--mantine-spacing-sm)",
        ...style,
      }}
    >
      {children}
    </SafeArea>
  );
}

export function MobileSelectorFooterInfo({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-footer-info",
  ...props
}: MobileSelectorRoleProps<HTMLDivElement>) {
  return (
    <div
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        display: "flex",
        flexDirection: "column",
        gap: "var(--mantine-spacing-xs)",
        paddingBlock: "var(--mantine-spacing-xs)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function MobileSelectorFooterActions({
  children,
  style,
  "data-myoxus-ui-role": uiRole = "mobile-selector-footer-actions",
  ...props
}: MobileSelectorRoleProps<HTMLDivElement>) {
  return (
    <div
      {...props}
      data-myoxus-ui-role={uiRole}
      style={{
        paddingBlock: "var(--mantine-spacing-xs)",
        paddingInline: "var(--mantine-spacing-sm)",
        width: "100%",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
