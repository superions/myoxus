// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type HTMLAttributes,
  forwardRef,
  type ComponentProps,
  type ReactNode,
  type CSSProperties,
} from "react";
import {
  Card as MantineCard,
  Stack,
  Center,
  Group,
  Flex as MantineFlex,
  Skeleton as MantineSkeleton,
  Text,
} from "@mantine/core";
import { joinClassName } from "./helpers/class-name";
import { type RoleBoxProps } from "./helpers/ui-role";
import { SettingsNotice } from "./settings/status";
import { cssVar } from "@myoxus/theme";
import { type MyoxusTextProps, MyoxusText } from "./typography";
import { type MyoxusInputProps, Input } from "./input";

type PdfPreviewVariant = "default" | "thumbnail" | "attachment" | "embedded";

type PdfPreviewToolbarPlacement =
  "inline" | "top-end" | "bottom-center" | "side-end";

type PdfPreviewToolbarOrientation = "horizontal" | "vertical";

type PdfPreviewRoleProps = PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    variant?: PdfPreviewVariant;
    "data-testid"?: string;
    "data-myoxus-ui-role"?: string;
  }
>;

export const PDF_PREVIEW_CLASS_NAMES = Object.freeze({
  virtuoso: "myoxus-pdf-preview-virtuoso",
  virtuosoList: "myoxus-pdf-preview-virtuoso-list",
  virtuosoListSmallGap: "myoxus-pdf-preview-virtuoso-list-small-gap",
  virtuosoItem: "myoxus-pdf-preview-virtuoso-item",
  listPadding: "myoxus-pdf-preview-list-padding",
  page: "myoxus-pdf-preview-page",
  thumbnailPage: "myoxus-pdf-preview-thumbnail-page",
  rendererPage: "myoxus-pdf-preview-renderer-page",
  textLayer: "myoxus-pdf-preview-text-layer",
  textHighlight: "myoxus-pdf-preview-text-highlight",
  textCurrentMatch: "myoxus-pdf-preview-text-current-match",
  annotationLayer: "myoxus-pdf-preview-annotation-layer",
  loading: "myoxus-pdf-preview-loading",
  loadingOverlay: "myoxus-pdf-preview-loading-overlay",
  loadingOverlayVisible: "myoxus-pdf-preview-loading-overlay-visible",
});

export const PdfPreviewShell = forwardRef<HTMLDivElement, PdfPreviewRoleProps>(
  function PdfPreviewShell(
    {
      children,
      className,
      style,
      variant = "default",
      "data-myoxus-ui-role": uiRole = "pdf-preview-shell",
      ...props
    },
    ref,
  ) {
    if (variant === "default") {
      return (
        <MantineCard
          {...props}
          ref={ref}
          className={className}
          data-variant={variant}
          data-myoxus-ui-role={uiRole}
          p={0}
          style={style}
        >
          {children}
        </MantineCard>
      );
    }

    if (variant === "attachment" || variant === "embedded") {
      return (
        <Stack
          {...props}
          ref={ref}
          className={className}
          data-variant={variant}
          data-myoxus-ui-role={uiRole}
          gap={0}
          h="100%"
          miw={0}
          style={style}
        >
          {children}
        </Stack>
      );
    }

    return (
      <div
        {...props}
        ref={ref}
        className={joinClassName("myoxus-pdf-preview-shell", className)}
        data-variant={variant}
        data-myoxus-ui-role={uiRole}
        style={style}
      >
        {children}
      </div>
    );
  },
);

export function PdfPreviewToolbar({
  children,
  className,
  orientation = "horizontal",
  placement = "inline",
  style,
  "data-myoxus-ui-role": uiRole = "pdf-preview-toolbar",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    orientation?: PdfPreviewToolbarOrientation;
    placement?: PdfPreviewToolbarPlacement;
    "data-myoxus-ui-role"?: string;
  }
>) {
  // PDF overlays are shared chrome, but page sizing remains renderer-owned.
  // Product viewers pass controls; the facade owns density, placement and
  // typography so attachment, Admin and export previews cannot drift apart.
  if (uiRole === "pdf-preview-loading") {
    return (
      <Center
        {...props}
        className={className}
        data-orientation={orientation}
        data-placement={placement}
        data-myoxus-ui-role={uiRole}
        m="auto"
        style={style}
      >
        {children}
      </Center>
    );
  }

  if (uiRole === "pdf-preview-status-actions") {
    return (
      <Group
        {...props}
        className={className}
        data-orientation={orientation}
        data-placement={placement}
        data-myoxus-ui-role={uiRole}
        gap="xs"
        justify="flex-end"
        pt="xs"
        style={style}
        wrap="nowrap"
      >
        {children}
      </Group>
    );
  }

  const content =
    orientation === "vertical" ? (
      <Stack gap="xs">{children}</Stack>
    ) : (
      <Group gap="xs" wrap="nowrap">
        {children}
      </Group>
    );

  return (
    <MantineCard
      {...props}
      className={joinClassName("myoxus-pdf-preview-toolbar", className)}
      data-orientation={orientation}
      data-placement={placement}
      data-myoxus-ui-role={uiRole}
      p="xs"
      style={style}
    >
      {content}
    </MantineCard>
  );
}

export function PdfPreviewError({
  children,
  className,
  role = "alert",
  style,
}: RoleBoxProps & { role?: string }) {
  return (
    <SettingsNotice
      className={className}
      data-myoxus-ui-role="pdf-preview-error"
      role={role}
      style={style}
      tone="error"
    >
      {children}
    </SettingsNotice>
  );
}

export function PdfPreviewViewport({
  children,
  className,
  style,
  variant = "default",
  "data-myoxus-ui-role": uiRole = "pdf-preview-viewport",
  ...props
}: PdfPreviewRoleProps) {
  if (variant === "default") {
    return (
      <MantineFlex
        {...props}
        className={className}
        data-variant={variant}
        data-myoxus-ui-role={uiRole}
        align="flex-start"
        justify="center"
        mih={"70vh"}
        p="sm"
        // Canvas dimensions can exceed the preview rail; this is PDF renderer
        // geometry, not ordinary product chrome.
        style={{ overflow: "auto", ...style }}
      >
        {children}
      </MantineFlex>
    );
  }

  return (
    <div
      {...props}
      className={joinClassName("myoxus-pdf-preview-viewport", className)}
      data-variant={variant}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </div>
  );
}

export const PdfPreviewCanvas = forwardRef<
  HTMLCanvasElement,
  ComponentProps<"canvas"> & {
    "data-render-state"?: string;
    variant?: PdfPreviewVariant;
  }
>(function PdfPreviewCanvas({ className, variant = "default", ...props }, ref) {
  return (
    <canvas
      {...props}
      ref={ref}
      className={joinClassName("myoxus-pdf-preview-canvas", className)}
      data-variant={variant}
      data-myoxus-ui-role="pdf-preview-canvas"
    />
  );
});

export function PdfPreviewSkeleton({
  className,
  style,
  variant = "default",
  "data-myoxus-ui-role": uiRole = "pdf-preview-skeleton",
  ...props
}: Omit<PdfPreviewRoleProps, "children">) {
  return (
    <MantineSkeleton
      {...props}
      className={joinClassName("myoxus-pdf-preview-skeleton", className)}
      data-variant={variant}
      data-myoxus-ui-role={uiRole}
      style={style}
    />
  );
}

export function PdfPreviewNotice({
  children,
  className,
  style,
  variant = "default",
  "data-myoxus-ui-role": uiRole = "pdf-preview-notice",
  ...props
}: PdfPreviewRoleProps) {
  return (
    <Text
      {...props}
      component="span"
      className={joinClassName("myoxus-pdf-preview-notice", className)}
      data-variant={variant}
      data-myoxus-ui-role={uiRole}
      style={style}
    >
      {children}
    </Text>
  );
}

export function PdfPreviewFooter({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      bg={cssVar("backgroundPrimaryColor")}
      className={className}
      data-myoxus-ui-role="pdf-preview-footer"
      gap="md"
      justify="space-between"
      miw={0}
      px="sm"
      py="xs"
      style={style}
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export function PdfPreviewFooterItem({
  children,
  className,
  style,
  truncate = false,
  "data-myoxus-ui-role": uiRole = "pdf-preview-footer-item",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    truncate?: boolean;
    "data-myoxus-ui-role"?: string;
  }
>) {
  return (
    <Group
      {...props}
      className={className}
      data-myoxus-ui-role={uiRole}
      flex={truncate ? "1 1 auto" : undefined}
      gap="xs"
      miw={0}
      style={style}
      wrap="nowrap"
    >
      {children}
    </Group>
  );
}

export function PdfPreviewMeta({
  children,
  className,
  component = "span",
  tone = "secondary",
  truncate = false,
  style,
  "data-myoxus-ui-role": uiRole = "pdf-preview-meta",
  ...props
}: MyoxusTextProps & {
  truncate?: boolean;
  "data-myoxus-ui-role"?: string;
}) {
  return (
    <MyoxusText
      {...props}
      className={className}
      component={component}
      tone={tone}
      typographySlot="body-small"
      data-myoxus-ui-role={uiRole}
      style={style}
      truncate={truncate}
    >
      {children}
    </MyoxusText>
  );
}

export function PdfPreviewPageCounter({
  current,
  total,
  empty = "-",
  className,
  style,
}: {
  current: ReactNode;
  total: ReactNode;
  empty?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <PdfPreviewMeta
      className={className}
      data-myoxus-ui-role="pdf-preview-page-counter"
      flexShrink={0}
      style={style}
    >
      <span className="page-cursor">{current ?? empty}</span>
      <span aria-hidden="true">/</span>
      <span className="page-count">{total ?? empty}</span>
    </PdfPreviewMeta>
  );
}

export function PdfPreviewThumbnailRail({
  children,
  className,
  collapsed = false,
  footer,
  style,
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLDivElement> & {
    collapsed?: boolean;
    footer?: ReactNode;
  }
>) {
  return (
    <aside
      {...props}
      className={joinClassName("myoxus-pdf-preview-thumbnail-rail", className)}
      data-collapsed={collapsed ? "true" : "false"}
      data-myoxus-ui-role="pdf-preview-thumbnail-rail"
      style={style}
    >
      <div
        className="myoxus-pdf-preview-thumbnail-list"
        data-myoxus-ui-role="pdf-preview-thumbnail-list"
      >
        {children}
      </div>
      {footer ? (
        <div
          className="myoxus-pdf-preview-thumbnail-footer"
          data-myoxus-ui-role="pdf-preview-thumbnail-footer"
        >
          {footer}
        </div>
      ) : null}
    </aside>
  );
}

export function PdfPreviewSearchField({
  className,
  inputStyle,
  noBorder = true,
  block = true,
  ...props
}: MyoxusInputProps) {
  return (
    <Input
      {...props}
      block={block}
      className={className}
      data-myoxus-ui-role="pdf-preview-search-field"
      flex="1 1 auto"
      miw={0}
      noBorder={noBorder}
      inputStyle={{
        minInlineSize: 0,
        ...inputStyle,
      }}
    />
  );
}
