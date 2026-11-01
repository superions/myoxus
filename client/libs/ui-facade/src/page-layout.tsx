// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** Shared Mantine page frames and content rails. */
import { Box, Center, Stack } from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import {
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from "react";

import { Scrollable } from "./scrollable";

export type PageContentWidth =
  "narrow" | "content" | "wide" | "data" | "editor" | "full";

const PAGE_CONTENT_WIDTH_MAX: Record<PageContentWidth, string | undefined> = {
  narrow: "56rem",
  content: "72rem",
  wide: "80rem",
  data: "100rem",
  editor: "var(--myoxus-editor-width)",
  full: undefined,
};

export function PageFrame({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "page-frame",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Stack
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      flex="1 1 auto"
      gap={0}
      h={"100dvh"}
      mih={0}
      miw={0}
      pt={{
        base: "calc(\n    var(--mantine-spacing-sm) + calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-2xs)) +\n      var(--mantine-spacing-xs)\n  )",
        sm: 0,
      }}
    >
      {children}
    </Stack>
  );
}

export function PageFrameBody({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "page-frame-body",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Stack
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      flex="1 1 auto"
      gap={0}
      mih={0}
      miw={0}
    >
      {children}
    </Stack>
  );
}

export function PageScrollViewport({
  className,
  children,
  "data-myoxus-ui-role": uiRole = "page-scroll",
}: PropsWithChildren<{
  className?: string;
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <Scrollable.Viewport
      className={className}
      data-myoxus-ui-role={uiRole}
      bg={cssVar("backgroundPrimaryColor")}
      fill
    >
      {children}
    </Scrollable.Viewport>
  );
}

export function PageContentRail({
  children,
  className,
  style,
  width = "data",
  centerContent = false,
  fill = false,
  scroll = false,
  spacious = false,
  subnav = false,
  "data-myoxus-ui-role": uiRole = "page-content-rail",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    className?: string;
    width?: PageContentWidth;
    centerContent?: boolean;
    fill?: boolean;
    scroll?: boolean;
    spacious?: boolean;
    subnav?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  const isEditorRail = width === "editor";
  const maxWidth = PAGE_CONTENT_WIDTH_MAX[width];
  const inlinePadding = {
    base: "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
    sm: "var(--mantine-spacing-md)",
    lg: "var(--mantine-spacing-lg)",
  };
  const scrollPadding = scroll
    ? { base: "var(--mantine-spacing-md)", lg: "var(--mantine-spacing-lg)" }
    : undefined;
  const subnavPaddingTop = subnav
    ? { base: "var(--mantine-spacing-xs)", sm: "var(--mantine-spacing-sm)" }
    : undefined;

  const railProps = {
    ...props,
    className,
    "data-center-content": centerContent ? "true" : undefined,
    "data-fill": fill ? "true" : undefined,
    "data-myoxus-ui-role": uiRole,
    "data-scroll": scroll ? "true" : undefined,
    "data-spacious": spacious ? "true" : undefined,
    "data-subnav": subnav ? "true" : undefined,
    "data-width": width,
    flex: fill ? "1 1 auto" : undefined,
    h: fill ? "100%" : undefined,
    maw: maxWidth,
    mih: fill ? 0 : undefined,
    miw: fill ? 0 : undefined,
    mx: maxWidth ? "auto" : undefined,
    overflow: fill ? "hidden" : undefined,
    pb: subnav ? "var(--mantine-spacing-xs)" : scrollPadding,
    pt: subnav ? subnavPaddingTop : scrollPadding,
    px: isEditorRail ? undefined : inlinePadding,
    style: isEditorRail
      ? {
          ...style,
          paddingLeft: "var(--myoxus-editor-content-padding-inline)",
          paddingRight: "var(--myoxus-editor-content-padding-inline)",
        }
      : style,
    w: "100%",
  };

  if (spacious) {
    return (
      <Stack
        {...railProps}
        align={centerContent ? "center" : undefined}
        gap={"var(--mantine-spacing-lg)"}
        justify={centerContent ? "center" : undefined}
      >
        {children}
      </Stack>
    );
  }

  if (centerContent) {
    return <Center {...railProps}>{children}</Center>;
  }

  return (
    <Box
      {...railProps}
      display={spacious || fill ? "flex" : centerContent ? "grid" : undefined}
    >
      {children}
    </Box>
  );
}

export function EmptyStateTitle({
  children,
  icon,
  "data-myoxus-ui-role": uiRole = "empty-state-title",
}: PropsWithChildren<{
  icon?: ReactNode;
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <Box
      component="span"
      data-myoxus-ui-role={uiRole}
      style={{
        alignItems: "center",
        display: "inline-flex",
        flexWrap: "wrap",
        gap: "var(--mantine-spacing-xs)",
        justifyContent: "center",
        minWidth: 0,
        textAlign: "center",
      }}
    >
      {icon ? (
        <Box
          component="span"
          aria-hidden="true"
          data-myoxus-ui-role={`${uiRole}:icon`}
          style={{
            color: cssVar("iconSecondary"),
            display: "inline-flex",
            flexShrink: 0,
            fontSize:
              "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
            lineHeight: 0,
          }}
        >
          {icon}
        </Box>
      ) : null}
      <Box component="span" data-myoxus-ui-role={`${uiRole}:label`}>
        {children}
      </Box>
    </Box>
  );
}

export function PageSubnavSurface({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "page-subnav-surface",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & { "data-myoxus-ui-role"?: string }
>) {
  return (
    <Box
      {...props}
      bg={cssVar("backgroundPrimaryColor")}
      className={className}
      flex="0 0 auto"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </Box>
  );
}
