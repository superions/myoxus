// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import {
  type CSSProperties,
  type ReactEventHandler,
  type HTMLAttributes,
  forwardRef,
} from "react";
import {
  Center,
  Paper,
  ThemeIcon,
  Image as MantineImage,
  Box,
  Stack,
  Group,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { MyoxusText, MyoxusTitle } from "./typography";
import { type MyoxusIconButtonProps, IconButton } from "./button";
import { CloseIcon } from "@myoxus/icons/react";

export const MediaPreviewFrame = forwardRef<
  HTMLDivElement,
  RoleBoxProps & {
    aspectRatio?: CSSProperties["aspectRatio"];
    fit?: "contain" | "cover";
    /** Fit an already bounded flex/grid slot without displacing its controls. */
    fill?: boolean;
    selected?: boolean;
  }
>(function MediaPreviewFrame(
  {
    aspectRatio = "1",
    children,
    fit = "contain",
    fill = false,
    selected = false,
    className,
    style,
    "data-testid": dataTestId,
    ...props
  },
  ref,
) {
  // File/media previews share Mantine surface primitives with settings cards.
  // Product routes supply content only; frame, selection border and centering
  // stay here so preview grids do not grow route-local CSS systems.
  return (
    <Paper
      {...props}
      ref={ref}
      component={Center<"div">}
      withBorder
      className={className}
      data-selected={selected ? "true" : undefined}
      data-testid={dataTestId}
      style={{
        aspectRatio: fill ? undefined : aspectRatio,
        height: fill ? "100%" : undefined,
        ...(selected ? { borderColor: cssVar("primaryColor") } : {}),
        overflow: "hidden",
        padding:
          fit === "cover"
            ? 0
            : "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role="media-preview-frame"
    >
      {children}
    </Paper>
  );
});

export function MediaPreviewImage({
  alt,
  fit = "contain",
  onError,
  onLoad,
  src,
}: {
  alt: string;
  fit?: "contain" | "cover";
  onError?: ReactEventHandler<HTMLImageElement>;
  onLoad?: ReactEventHandler<HTMLImageElement>;
  src: string;
}) {
  return (
    <MantineImage
      alt={alt}
      fit={fit}
      loading="lazy"
      onError={onError}
      onLoad={onLoad}
      src={src}
      style={{ height: "100%", width: "100%" }}
      data-myoxus-ui-role="media-preview-image"
    />
  );
}

export function MediaPreviewIcon({
  className,
  previewSize,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { previewSize?: "file" }) {
  return (
    <ThemeIcon
      {...props}
      className={className}
      color={cssVar("iconColor")}
      // File glyphs use em dimensions; inherit the native icon slot size rather
      // than the surrounding body text size so file types remain legible.
      fz="var(--ti-size)"
      size="lg"
      variant="transparent"
      style={{
        flex: previewSize === "file" ? "0 0 auto" : undefined,
        ...style,
      }}
      data-myoxus-ui-role="media-preview-icon"
    />
  );
}

export type AttachmentViewerRootProps = RoleBoxProps & {
  grid?: boolean;
  scrollable?: boolean;
};

export const AttachmentViewerRoot = forwardRef<
  HTMLDivElement,
  AttachmentViewerRootProps
>(function AttachmentViewerRoot(
  {
    children,
    className,
    grid = false,
    scrollable = false,
    style,
    "data-testid": dataTestId,
    ...props
  },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={className}
      data-grid={grid ? "true" : undefined}
      data-scrollable={scrollable ? "true" : undefined}
      data-testid={dataTestId}
      style={style}
      data-myoxus-ui-role="attachment-viewer-root"
    >
      {children}
    </Box>
  );
});

export function AttachmentViewerContainer({
  children,
  ...props
}: RoleBoxProps) {
  return (
    <Stack
      {...props}
      gap={0}
      h="100%"
      pos="relative"
      w="100%"
      data-myoxus-ui-role="attachment-viewer-container"
    >
      {children}
    </Stack>
  );
}

export function AttachmentViewerTitlebar({ children, ...props }: RoleBoxProps) {
  return (
    <Group
      {...props}
      gap="sm"
      p="xs"
      wrap="nowrap"
      data-myoxus-ui-role="attachment-viewer-titlebar"
    >
      {children}
    </Group>
  );
}

export function AttachmentViewerTitlebarGroup({
  children,
  ...props
}: RoleBoxProps) {
  return (
    <Group
      {...props}
      flex={1}
      gap="sm"
      miw={0}
      wrap="nowrap"
      data-myoxus-ui-role="attachment-viewer-titlebar-group"
    >
      {children}
    </Group>
  );
}

export function AttachmentViewerTitle({
  extension,
  name,
}: {
  extension: string;
  name: string;
}) {
  return (
    <Group
      flex="1 1 auto"
      gap={0}
      miw={0}
      wrap="nowrap"
      data-myoxus-ui-role="attachment-viewer-title"
    >
      <MyoxusText
        component="span"
        tone="primary"
        truncate
        typographySlot="body-small"
      >
        {name}
      </MyoxusText>
      <MyoxusText
        component="span"
        tone="secondary"
        truncate
        typographySlot="body-small"
      >
        .{extension}
      </MyoxusText>
    </Group>
  );
}

export function AttachmentViewerMeta({ children, ...props }: RoleBoxProps) {
  return (
    <MyoxusText
      {...props}
      component="span"
      tone="secondary"
      truncate
      typographySlot="body-small"
      data-myoxus-ui-role="attachment-viewer-meta"
    >
      {children}
    </MyoxusText>
  );
}

export function AttachmentViewerErrorRoot({
  children,
  ...props
}: RoleBoxProps) {
  return (
    <AttachmentViewerRoot>
      <Stack
        {...props}
        align="center"
        flex={1}
        gap="xs"
        justify="center"
        data-myoxus-ui-role="attachment-viewer-error-root"
      >
        {children}
      </Stack>
    </AttachmentViewerRoot>
  );
}

export function AttachmentViewerErrorTitle({
  children,
  ...props
}: RoleBoxProps) {
  return (
    <MyoxusTitle
      {...props}
      mt="xs"
      order={3}
      tone="primary"
      typographySlot="heading-small"
      data-myoxus-ui-role="attachment-viewer-error-title"
    >
      {children}
    </MyoxusTitle>
  );
}

export function AttachmentViewerErrorMessage({
  children,
  ...props
}: RoleBoxProps) {
  return (
    <MyoxusText
      {...props}
      component="p"
      m={0}
      tone="tertiary"
      typographySlot="body-small"
      data-myoxus-ui-role="attachment-viewer-error-message"
    >
      {children}
    </MyoxusText>
  );
}

export function AttachmentViewerErrorActions({
  children,
  ...props
}: RoleBoxProps) {
  return (
    <Stack
      {...props}
      gap="sm"
      mt="lg"
      data-myoxus-ui-role="attachment-viewer-error-actions"
    >
      {children}
    </Stack>
  );
}

export const MediaLightboxCloseButton = forwardRef<
  HTMLButtonElement,
  Omit<MyoxusIconButtonProps, "icon">
>(function MediaLightboxCloseButton(
  { style, tooltip = "Close", variant = "default", ...props },
  ref,
) {
  // This action is anchored to the lightbox frame rather than participating in
  // its content layout. Keep that technical overlay geometry in the Facade so
  // Mantine ActionIcon's native positioning cannot override route CSS.
  return (
    <IconButton
      {...props}
      ref={ref}
      icon={<CloseIcon />}
      tooltip={tooltip}
      variant={variant}
      style={{
        ...style,
        insetBlockStart: "var(--mantine-spacing-xs)",
        insetInlineEnd: "var(--mantine-spacing-xs)",
        position: "absolute",
        zIndex: 2,
      }}
      data-myoxus-ui-role="media-lightbox-close-button"
    />
  );
});
