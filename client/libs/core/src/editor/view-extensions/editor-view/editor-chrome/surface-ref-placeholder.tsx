// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Card, Group, MyoxusText, Stack } from "@myoxus/ui-facade";
import type { EditorSurfaceRefPlaceholderControls } from "@virgultum/editor/shared/services";

import { editorGlyph } from "./glyphs";

/** Native Mantine card replacing imperative surface-ref placeholder DOM/CSS. */
export function EditorSurfaceRefPlaceholder({
  controls,
}: {
  controls: EditorSurfaceRefPlaceholderControls;
}) {
  return (
    <Card
      withBorder={false}
      padding="sm"
      data-surface-ref-not-found={controls.notFound ? "true" : undefined}
    >
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap" align="center">
          {editorGlyph(controls.icon)}
          <MyoxusText component="span" typographySlot="body-small" truncate>
            {controls.title}
          </MyoxusText>
        </Group>
        <MyoxusText
          component="span"
          typographySlot="dense-label"
          tone="secondary"
          truncate
        >
          {controls.description}
        </MyoxusText>
      </Stack>
    </Card>
  );
}
