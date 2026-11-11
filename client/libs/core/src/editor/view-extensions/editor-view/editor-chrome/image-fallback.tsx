// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { BrokenImageIcon, ImageIcon } from "@myoxus/icons/react";
import {
  Grid,
  Group,
  Loading,
  MyoxusText,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import type { EditorImageFallbackControls } from "@virgultum/editor/shared/services";

export function EditorImageFallback({
  controls,
}: {
  controls: EditorImageFallbackControls;
}) {
  const t = useI18n();
  const card = (
    <SurfaceListItem
      component="div"
      appearance="card"
      fullHeight
      className="drag-target"
      data-testid="editor-image-fallback"
      aria-busy={controls.loading}
    >
      <Stack gap="xs" miw={0}>
        <Group wrap="nowrap" gap="xs">
          {controls.loading ? (
            <Loading />
          ) : controls.error ? (
            <BrokenImageIcon />
          ) : (
            <ImageIcon />
          )}
          <MyoxusText truncate>
            <strong>{t["Image"]()}</strong>
          </MyoxusText>
        </Group>
        <MyoxusText tone="secondary" truncate title={controls.description}>
          {controls.description}
        </MyoxusText>
      </Stack>
    </SurfaceListItem>
  );
  return controls.inSurface ? (
    card
  ) : (
    <Grid>
      <Grid.Col span="content" maw="50%">
        {card}
      </Grid.Col>
    </Grid>
  );
}
