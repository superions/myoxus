// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ComponentProps,
  forwardRef,
  type ImgHTMLAttributes,
  type HTMLAttributes,
  type CSSProperties,
  type PropsWithChildren,
} from "react";
import { Scrollable } from "./scrollable";
import { joinClassName } from "./helpers/class-name";
import { type RoleBoxProps } from "./helpers/ui-role";
import { Box, Stack } from "@mantine/core";
import { type InlineEditProps, InlineEdit } from "./inline-edit";
import { Badge } from "./badge";
import { cssVar } from "@myoxus/theme";

type EditorPageViewportProps = ComponentProps<typeof Scrollable.Viewport> & {
  "data-myoxus-ui-role"?: string;
};

export const EditorPageViewport = forwardRef<
  HTMLDivElement,
  EditorPageViewportProps
>(function EditorPageViewport(
  {
    className,
    "data-myoxus-ui-role": uiRole = "editor-page-viewport",
    ...props
  },
  ref,
) {
  return (
    <Scrollable.Viewport
      {...props}
      ref={ref}
      className={joinClassName("myoxus-page-viewport", className)}
      data-myoxus-ui-role={uiRole}
    />
  );
});

export function DetailPageMainFrame({
  children,
  className,
  dynamicTopBorder,
  editorMode,
  hasScrollTop,
  style,
  ...props
}: RoleBoxProps & {
  dynamicTopBorder?: boolean;
  editorMode?: string;
  hasScrollTop?: boolean;
}) {
  const edgeless = editorMode === "edgeless";
  return (
    <Box
      {...props}
      className={joinClassName("myoxus-detail-page-main-frame", className)}
      data-dynamic-top-border={dynamicTopBorder}
      data-editor-mode={editorMode}
      data-has-scroll-top={hasScrollTop}
      data-myoxus-ui-role="detail-page-main-frame"
      flex={edgeless ? "1 1 auto" : undefined}
      mih={edgeless ? 0 : undefined}
      style={style}
      w="100%"
    >
      {children}
    </Box>
  );
}

export function DetailPageEditorFrame({
  children,
  className,
  editorMode,
  style,
  ...props
}: RoleBoxProps & { editorMode?: string }) {
  const edgeless = editorMode === "edgeless";
  return (
    <Box
      {...props}
      className={joinClassName("myoxus-detail-page-editor-frame", className)}
      data-myoxus-ui-role="detail-page-editor-frame"
      flex={edgeless ? "1 1 auto" : undefined}
      mih={edgeless ? 0 : undefined}
      style={style}
      w="100%"
    >
      {children}
    </Box>
  );
}

export const EditorOutlineFloatingFrame = forwardRef<
  HTMLDivElement,
  RoleBoxProps
>(function EditorOutlineFloatingFrame({ className, ...props }, ref) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(
        "myoxus-editor-outline-floating-frame",
        className,
      )}
      data-myoxus-ui-role="editor-outline-floating-frame"
    />
  );
});

export type DocumentHeaderImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  "data-myoxus-ui-role"?: string;
};

export type DetailPageEditorRootAttrs = Pick<
  HTMLAttributes<HTMLDivElement>,
  "className"
> & {
  "data-full-width-layout"?: "true";
};

export function detailPageEditorRootAttrs({
  fullWidthLayout = false,
}: {
  fullWidthLayout?: boolean;
} = {}): DetailPageEditorRootAttrs {
  return {
    className: "myoxus-page-detail-editor",
    "data-full-width-layout": fullWidthLayout ? "true" : undefined,
  };
}

export function DocumentHeaderImage({
  className,
  style,
  alt = "Document header",
  "data-myoxus-ui-role": uiRole = "document-header-image",
  ...props
}: DocumentHeaderImageProps) {
  return (
    <Box
      component="img"
      {...props}
      alt={alt}
      className={className}
      style={{
        borderRadius: "var(--mantine-radius-lg)",
        display: "block",
        marginBottom: "var(--mantine-spacing-md)",
        maxHeight: `calc(calc(var(--mantine-spacing-2xl) * 2) * 4)`,
        objectFit: "cover",
        width: "100%",
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    />
  );
}

export function DocumentHeaderTitleInlineEdit({
  className,
  ...props
}: InlineEditProps) {
  return (
    <InlineEdit
      {...props}
      className={joinClassName("myoxus-document-header-title-edit", className)}
      data-myoxus-ui-role="document-header-title-inline-edit"
    />
  );
}

export const documentEditorContentClassName = "myoxus-document-editor-content";

export const commentEditorViewportClassName = "myoxus-comment-editor-viewport";

export const DocumentEditorRoot = forwardRef<
  HTMLDivElement,
  RoleBoxProps & {
    /** Personal reading size in pixels; null/undefined preserves theme typography. */
    readingSize?: number | null;
    /** Embed a native body in the surrounding section's layout. */
    contentOnly?: boolean;
    mode: string;
  }
>(function DocumentEditorRoot(
  { children, className, readingSize, contentOnly, mode, style, ...props },
  ref,
) {
  const rootStyle =
    readingSize == null || mode !== "page"
      ? style
      : ({
          "--myoxus-document-reading-size": `${readingSize}px`,
          ...style,
        } as CSSProperties);
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(
        "editor-wrapper",
        `${mode}-mode`,
        "myoxus-document-editor-root",
        className,
      )}
      data-editor-mode={mode}
      data-content-only={contentOnly || undefined}
      data-myoxus-editor-container=""
      data-myoxus-ui-role="document-editor-root"
      style={rootStyle}
    >
      {children}
    </Box>
  );
});

export function DocumentEditorPageViewport({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Stack
      {...props}
      className={joinClassName(
        "myoxus-document-editor-page-viewport",
        className,
      )}
      data-myoxus-ui-role="document-editor-page-viewport"
      style={style}
    >
      {children}
    </Stack>
  );
}

export function DocumentEditorEdgelessViewport({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={joinClassName(
        "myoxus-document-editor-edgeless-viewport",
        className,
      )}
      data-myoxus-ui-role="document-editor-edgeless-viewport"
      style={style}
    >
      {children}
    </Box>
  );
}

export function DocumentEditorBlankGap({ className, ...props }: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={joinClassName("myoxus-document-editor-blank-gap", className)}
      data-myoxus-ui-role="document-editor-blank-gap"
    />
  );
}

export function JournalDocumentDayTag({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Badge
      {...props}
      className={className}
      tone="neutral"
      data-myoxus-ui-role="journal-document-day-tag"
    >
      {children}
    </Badge>
  );
}

export const DetailPageEditorViewport = forwardRef<
  HTMLDivElement,
  RoleBoxProps & {
    dragging?: boolean;
    editorMode?: string;
    pageModeContentBox?: boolean;
  }
>(function DetailPageEditorViewport(
  { className, dragging, editorMode, pageModeContentBox, ...props },
  ref,
) {
  const edgeless = editorMode === "edgeless";
  return (
    <Box
      {...props}
      ref={ref}
      bg={dragging ? cssVar("hoverColor") : cssVar("backgroundPrimaryColor")}
      className={joinClassName(
        "myoxus-page-viewport",
        "myoxus-detail-page-editor-viewport",
        pageModeContentBox
          ? "myoxus-detail-page-editor-viewport--page-mode"
          : undefined,
        className,
      )}
      data-dragging={dragging}
      data-editor-mode={editorMode}
      data-myoxus-ui-role="detail-page-editor-viewport"
      flex={edgeless ? "1 1 auto" : undefined}
      h={edgeless ? "100%" : undefined}
      mih={edgeless ? 0 : undefined}
      w="100%"
    />
  );
});

export const DetailPageMobileEditorViewport = forwardRef<
  HTMLDivElement,
  RoleBoxProps & { editorMode?: string }
>(function DetailPageMobileEditorViewport(
  { children, className, editorMode, style, ...props },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={joinClassName(
        "myoxus-page-viewport",
        "myoxus-detail-page-editor-viewport",
        "myoxus-detail-page-editor-viewport--mobile",
        className,
      )}
      data-editor-mode={editorMode}
      data-myoxus-ui-role="detail-page-mobile-editor-viewport"
      style={style}
    >
      {children}
    </Box>
  );
});

export function DocumentTitleRow({
  children,
  className,
  ...props
}: RoleBoxProps) {
  return (
    <Box
      {...props}
      className={joinClassName("myoxus-document-title-row", className)}
      data-myoxus-ui-role="document-title-row"
    >
      {children}
    </Box>
  );
}

export function WorkbenchContextScrollRoot({
  className,
  ...props
}: ComponentProps<typeof Scrollable.Root>) {
  return (
    <Scrollable.Root
      {...props}
      className={className}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "workbench-context-scroll-root"
      }
    />
  );
}

export function DetailPageContextScrollRoot({
  className,
  ...props
}: ComponentProps<typeof Scrollable.Root>) {
  return (
    <WorkbenchContextScrollRoot
      {...props}
      className={joinClassName(
        "myoxus-detail-page-context-scroll-root",
        className,
      )}
      data-myoxus-ui-role="detail-page-context-scroll-root"
    />
  );
}
