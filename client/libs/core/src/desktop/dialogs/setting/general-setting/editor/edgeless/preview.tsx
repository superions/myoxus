// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ReactNode } from "react";

import {
  Badge,
  ColorDot,
  EditorPreviewFrame,
  Group,
  MyoxusText,
  Paper,
  Stack,
} from "../../../primitives";

export interface EdgelessPreviewItem {
  label: string;
  value: ReactNode;
  color?: string;
}

export interface EdgelessStylePreviewProps {
  sampleTitle?: ReactNode;
  sampleBody?: ReactNode;
  items: EdgelessPreviewItem[];
}

/**
 * Lightweight, theme-safe preview card for Edgeless tool defaults.
 * Renders declarative style badges so the Editor settings tab opens
 * immediately without mounting embedded canvas runtimes.
 */
export const EdgelessStylePreview = ({
  sampleTitle,
  sampleBody,
  items,
}: EdgelessStylePreviewProps) => {
  return (
    <EditorPreviewFrame>
      <Paper withBorder p="md" radius="md">
        <Stack gap="xs">
          {sampleTitle ? (
            <MyoxusText typographySlot="body" tone="primary">
              {sampleTitle}
            </MyoxusText>
          ) : null}
          {sampleBody ? (
            <MyoxusText typographySlot="caption" tone="secondary">
              {sampleBody}
            </MyoxusText>
          ) : null}
          <Group gap="xs" wrap="wrap">
            {items.map((item) => (
              <Badge
                key={item.label}
                tone="neutral"
                prefix={
                  item.color ? <ColorDot color={item.color} /> : undefined
                }
              >
                {item.label}: {item.value}
              </Badge>
            ))}
          </Group>
        </Stack>
      </Paper>
    </EditorPreviewFrame>
  );
};
