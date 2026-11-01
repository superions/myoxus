// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import { Box, Group, Paper, Stack } from "@mantine/core";
import { joinClassName } from "./helpers/class-name";
import { forwardRef, type PropsWithChildren } from "react";
import { Skeleton } from "./feedback";

export type EditorPreviewSize = "default" | "flow" | "mindmap" | "note";

const editorPreviewHeightBySize: Record<EditorPreviewSize, string> = {
  default: "180px",
  flow: "456px",
  mindmap: "320px",
  note: "240px",
};

export function EditorPreviewFrame({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  // Edgeless previews need a stable DOM marker for the editor viewport
  // extension. The marker and spacing live here so editor settings do not keep
  // route-local preview CSS while still isolating renderer geometry.
  return (
    <Stack
      {...props}
      mb="md"
      aria-hidden="true"
      className={joinClassName("setting-editor-snapshot", className)}
      data-myoxus-ui-role="editor-preview-frame"
      style={{
        position: "relative",
        ...style,
      }}
    >
      {children}
    </Stack>
  );
}

export const EditorPreviewViewport = forwardRef<
  HTMLDivElement,
  PropsWithChildren<
    RoleBoxProps & {
      size?: EditorPreviewSize;
    }
  >
>(function EditorPreviewViewport(
  { children, className, size = "default", style, ...props },
  ref,
) {
  return (
    <Box
      {...props}
      ref={ref}
      className={className}
      data-myoxus-ui-role="editor-preview-viewport"
      style={{
        height: editorPreviewHeightBySize[size],
        overflow: "hidden",
        pointerEvents: "none",
        position: "relative",
        userSelect: "none",
        ...style,
      }}
    >
      {children}
    </Box>
  );
});

export function EditorPreviewSkeleton() {
  return (
    <Skeleton
      variant="rounded"
      height="100%"
      style={{
        inset: 0,
        position: "absolute",
      }}
      data-myoxus-ui-role="editor-preview-skeleton"
    />
  );
}

export function EditorPreviewOverlay({
  children,
  className,
  style,
  ...props
}: RoleBoxProps) {
  return (
    <Paper
      {...props}
      component={Group}
      wrap="nowrap"
      className={className}
      data-myoxus-ui-role="editor-preview-overlay"
      style={{
        bottom: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        position: "absolute",
        right: "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        ...style,
      }}
    >
      {children}
    </Paper>
  );
}
