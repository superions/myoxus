// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  type CSSProperties,
  type AnchorHTMLAttributes,
} from "react";
import {
  Center,
  Paper as MantinePaper,
  Stack,
  Code as MantineCode,
  Box,
  Collapse as MantineCollapse,
  Text,
  Group,
} from "@mantine/core";
import { type ThemedImgProps, ThemedImg } from "./themed-img";
import { Scrollable } from "./scrollable";
import { type MyoxusButtonProps, Button } from "./button";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";

type DataTableChromeProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    "data-myoxus-ui-role"?: string;
  }
>;

type ExceptionBoundaryScope = "app" | "page";

type ExceptionBoundaryChromeProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    scope?: ExceptionBoundaryScope;
    "data-myoxus-ui-role"?: string;
  }
>;

/**
 * Shared crash-state frame for route and app error boundaries. Error recovery
 * UI needs the same theme-backed chrome as ordinary panels, but it must not
 * depend on route-local Admin/Web CSS because it renders exactly when route
 * code may be broken.
 */
export function ExceptionBoundaryFrame({
  children,
  className,
  scope = "page",
  "data-myoxus-ui-role": uiRole = "exception-boundary-frame",
  ...props
}: ExceptionBoundaryChromeProps) {
  const isAppScope = scope === "app";

  return (
    <Center
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      data-myoxus-ui-scope={scope}
      mih={isAppScope ? "100dvh" : undefined}
      p={isAppScope ? "lg" : "xl"}
      w="100%"
    >
      {children}
    </Center>
  );
}

/**
 * Centered error surface used inside `ExceptionBoundaryFrame`. Consumers pass
 * translated content and actions; layout, spacing and typography remain a
 * shared facade concern.
 */
export function ExceptionBoundarySurface({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "exception-boundary-surface",
  ...props
}: DataTableChromeProps) {
  return (
    <MantinePaper
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      maw={"56rem"}
      p="xl"
      radius="md"
      shadow="xs"
      w="100%"
      withBorder
    >
      <Stack align="center" gap="md" ta="center">
        {children}
      </Stack>
    </MantinePaper>
  );
}

/**
 * Token-backed preformatted error details. It deliberately owns the `pre`
 * chrome so product routes do not recreate monospace crash boxes locally.
 */
export function ExceptionBoundaryDetails({
  children,
  className,
  "data-myoxus-ui-role": uiRole = "exception-boundary-details",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLPreElement> & {
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <MantineCode
      {...props}
      block
      className={className}
      color="myoxusError"
      data-myoxus-ui-role={uiRole}
    >
      {children}
    </MantineCode>
  );
}

/**
 * Relative viewport for fallback mounts. `height` is preserved as a legacy API
 * escape hatch; default sizing and visible chrome stay in facade CSS.
 */
export function ExceptionBoundaryViewport({
  children,
  className,
  height,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-viewport",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    height?: CSSProperties["height"];
    "data-myoxus-ui-role"?: string;
  }
>) {
  const viewportStyle =
    height === undefined
      ? style
      : ({
          height,
          ...style,
        } as CSSProperties);

  return (
    <Box
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      h={height === undefined ? "100%" : undefined}
      pos="relative"
      style={viewportStyle}
      w="100%"
    >
      {children}
    </Box>
  );
}

/**
 * Absolute crash-detail centering for legacy Core error-boundary mounts. Keep
 * this layout in the facade so fallback UI can render without route CSS.
 */
export function ExceptionBoundaryDetailLayout({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-detail-layout",
  ...props
}: DataTableChromeProps) {
  return (
    <Center
      {...props}
      bottom={0}
      className={className}
      data-myoxus-ui-role={uiRole}
      left={0}
      pos="absolute"
      right={0}
      style={style}
      top={0}
    >
      {children}
    </Center>
  );
}

/**
 * Token-sized error detail surface with an expanded state for stack traces.
 * Product code owns only the disclosure state; the facade owns the visual size.
 */
export function ExceptionBoundaryDetailSurface({
  children,
  className,
  expanded,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-detail-surface",
  ...props
}: DataTableChromeProps & {
  expanded?: boolean;
}) {
  return (
    <Stack
      {...props}
      align="stretch"
      className={className}
      data-myoxus-ui-role={uiRole}
      data-expanded={expanded ? "true" : undefined}
      gap="xs"
      h="100%"
      justify="center"
      maw={"100%"}
      p="xl"
      style={style}
      w="100%"
    >
      {children}
    </Stack>
  );
}

/**
 * Theme-aware error illustration slot. It wraps `ThemedImg` so route code does
 * not carry image sizing or light/dark asset switching chrome.
 */
export function ExceptionBoundaryIllustration({
  className,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-illustration",
  ...props
}: ThemedImgProps & {
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Box maw="sm" mx="auto" w="100%">
      <ThemedImg
        {...props}
        className={className}
        data-myoxus-ui-role={uiRole}
        fluid
        style={style}
      />
    </Box>
  );
}

/**
 * Copy stack for translated error title and body text. Overflow handling lives
 * here because crash text often contains unknown external error messages.
 */
export function ExceptionBoundaryCopy({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-copy",
  ...props
}: DataTableChromeProps) {
  return (
    <Stack
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      gap="2xs"
      miw={0}
      w="100%"
      style={style}
    >
      {children}
    </Stack>
  );
}

/**
 * Expandable scrollable stack-trace region for crash recovery. The shell owns
 * hidden/expanded semantics while Mantine-backed scroll chrome remains shared.
 */
export function ExceptionBoundaryStackTrace({
  children,
  className,
  expanded,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-stack-trace",
  ...props
}: DataTableChromeProps & {
  expanded?: boolean;
}) {
  return (
    <MantineCollapse
      className={className}
      expanded={Boolean(expanded)}
      data-expanded={expanded ? "true" : "false"}
      data-myoxus-ui-role={`${uiRole}:shell`}
    >
      <Scrollable.Root {...props} data-myoxus-ui-role={uiRole} style={style}>
        <Scrollable.Viewport>
          <Text c="dimmed" component="pre" size="sm">
            {children}
          </Text>
        </Scrollable.Viewport>
        <Scrollable.Scrollbar />
      </Scrollable.Root>
    </MantineCollapse>
  );
}

/**
 * Shared action row for recovery buttons inside legacy Core error details.
 */
export function ExceptionBoundaryActions({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-actions",
  ...props
}: DataTableChromeProps) {
  return (
    <Group
      {...props}
      align="center"
      className={className}
      data-myoxus-ui-role={uiRole}
      gap="lg"
      justify="center"
      mt="lg"
      style={style}
      w="100%"
    >
      {children}
    </Group>
  );
}

/**
 * Disclosure button for stack traces. It reuses the facade Button API so Core
 * does not need a local action-button variant or icon sizing rules.
 */
export function ExceptionBoundaryStackToggleButton({
  children,
  expanded,
  ...props
}: MyoxusButtonProps & {
  expanded?: boolean;
}) {
  return (
    <Button
      {...props}
      data-expanded={expanded ? "true" : "false"}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "button:exception-stack-toggle"
      }
      suffix={
        expanded ? (
          <ChevronDownIcon aria-hidden="true" />
        ) : (
          <ChevronRightIcon aria-hidden="true" />
        )
      }
      variant={props.variant ?? "secondary"}
    >
      {children}
    </Button>
  );
}

/**
 * Inline support link used inside translated crash copy.
 */
export function ExceptionBoundaryInlineLink({
  children,
  className,
  style,
  "data-myoxus-ui-role": uiRole = "exception-boundary-inline-link",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <Box
      {...props}
      component="a"
      className={className}
      c="myoxusInfo"
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </Box>
  );
}
