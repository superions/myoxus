// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import { Box, Group, Stack } from "@mantine/core";
import { cssVar, cssTypographyVar } from "@myoxus/theme";
import {
  type ComponentProps,
  type PropsWithChildren,
  type CSSProperties,
} from "react";
import { Scrollable } from "./scrollable";
import { joinClassName } from "./helpers/class-name";
import { MyoxusText } from "./typography";

/**
 * Public-share chrome is owned here so the read-only share route does not keep
 * a parallel page/header/footer CSS island next to the normal Web shell roles.
 */
export function PublicSharePageRoot({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role="public-share-page-root"
    >
      {children}
    </Box>
  );
}

export function PublicSharePageMain({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={className}
      style={{
        background: cssVar("backgroundPrimaryColor"),
        display: "flex",
        flex: 1,
        flexDirection: "column",
        height: "100%",
        minWidth: 0,
        overflow: "hidden",
        position: "relative",
        ...style,
      }}
      data-myoxus-ui-role="public-share-page-main"
    >
      {children}
    </Box>
  );
}

export function PublicShareHeaderBar({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      className={className}
      gap={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      wrap="nowrap"
      style={{
        background: cssVar("backgroundPrimaryColor"),
        borderBlockEnd: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
          "borderColor",
        )}`,
        flexShrink: 0,
        minHeight:
          "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        paddingInline:
          "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role="public-share-header-bar"
    >
      {children}
    </Group>
  );
}

export function PublicShareHeaderSpacer() {
  return (
    <Box
      style={{ flex: "1 1 auto", minWidth: "var(--mantine-spacing-sm)" }}
      data-myoxus-ui-role="public-share-header-spacer"
    />
  );
}

export function PublicShareEditorViewport({
  children,
  className,
  style,
  ...props
}: ComponentProps<typeof Scrollable.Viewport>) {
  return (
    <Scrollable.Viewport
      {...props}
      className={joinClassName("myoxus-page-viewport", className)}
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        position: "relative",
        zIndex: 0,
        ...style,
      }}
      data-myoxus-ui-role="public-share-editor-viewport"
    >
      {children}
    </Scrollable.Viewport>
  );
}

export function PublicShareFooterRoot({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={className}
      style={{
        alignItems: "center",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        marginBlockEnd: `calc(calc(var(--mantine-spacing-2xl) * 2) * 4)`,
        marginInline: "auto",
        maxWidth: cssVar("editorWidth"),
        paddingInline: `clamp(var(--mantine-spacing-lg), 8vw, var(--myoxus-editor-side-padding))`,
        width: "100%",
        zIndex: 1,
        ...style,
      }}
      data-myoxus-ui-role="public-share-footer-root"
    >
      {children}
    </Box>
  );
}

export function PublicShareFooterPanel({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Stack
      {...props}
      align="center"
      className={className}
      gap={"var(--mantine-spacing-xs)"}
      justify="center"
      style={{
        background: cssVar("backgroundOverlayPanelColor"),
        padding: "var(--mantine-spacing-sm)",
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role="public-share-footer-panel"
    >
      {children}
    </Stack>
  );
}

export function PublicShareFooterDescription({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component="p"
      tone="secondary"
      typographySlot="body-small"
      style={{ margin: 0, textAlign: "center", ...style }}
      data-myoxus-ui-role="public-share-footer-description"
    >
      {children}
    </MyoxusText>
  );
}

export function PublicShareFooterLink({
  children,
  href,
  target,
  rel,
  className,
  style,
}: PropsWithChildren<{
  href: string;
  target?: string;
  rel?: string;
  className?: string;
  style?: CSSProperties;
}>) {
  return (
    <Box
      component="a"
      href={href}
      target={target}
      rel={rel}
      className={className}
      style={{
        alignItems: "center",
        color: cssVar("linkColor"),
        display: "inline-flex",
        gap: "var(--mantine-spacing-xs)",
        justifyContent: "center",
        paddingInline: "var(--mantine-spacing-xs)",
        textDecoration: cssTypographyVar("link", "decoration", "none"),
        ...style,
      }}
      data-myoxus-ui-role="public-share-footer-link"
    >
      {children}
    </Box>
  );
}

export function PublicShareFloatingBrandLink({
  children,
  href,
  target,
  rel,
  className,
  style,
}: PropsWithChildren<{
  href: string;
  target?: string;
  rel?: string;
  className?: string;
  style?: CSSProperties;
}>) {
  return (
    <Box
      component="a"
      href={href}
      target={target}
      rel={rel}
      className={className}
      style={{
        alignItems: "center",
        background: cssVar("black"),
        borderColor: cssVar("pureBlack10"),
        borderStyle: "solid",
        borderWidth: "calc(var(--mantine-scale) * 1px)",
        borderRadius: "var(--mantine-radius-sm)",
        bottom: "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))",
        boxShadow: cssVar("buttonInnerShadow"),
        color: cssVar("white"),
        cursor: "pointer",
        display: "flex",
        gap: "var(--mantine-spacing-xs)",
        paddingBlock:
          "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        paddingInline: "var(--mantine-spacing-md)",
        position: "absolute",
        right: "50%",
        textDecoration: "none",
        transform: "translateX(50%)",
        zIndex: cssVar("zIndexPopover"),
        ...style,
      }}
      data-myoxus-ui-role="public-share-floating-brand-link"
    >
      {children}
    </Box>
  );
}

export function PublicShareFloatingBrandText({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component="span"
      typographySlot="body-small"
      style={{
        color: "currentColor",
        fontWeight:
          "var(--mantine-font-weight-body-small, var(--mantine-font-weight-regular))",
        paddingInline: "var(--mantine-spacing-xs)",
        whiteSpace: "nowrap",
        ...style,
      }}
      data-myoxus-ui-role="public-share-floating-brand-text"
    >
      {children}
    </MyoxusText>
  );
}

export function PublicShareFloatingBrandIcon({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={className}
      style={{
        alignItems: "center",
        display: "flex",
        height: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        justifyContent: "center",
        width: "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        ...style,
      }}
      data-myoxus-ui-role="public-share-floating-brand-icon"
    >
      {children}
    </Box>
  );
}
