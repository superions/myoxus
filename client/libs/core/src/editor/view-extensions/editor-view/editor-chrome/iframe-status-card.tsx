// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  EditIcon,
  EmbedIcon,
  ResetIcon,
  WarningIcon,
} from "@myoxus/icons/react";
import {
  Grid,
  Group,
  IconButton,
  Loading,
  MyoxusText,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import type { EditorIframeStatusCardControls } from "@virgultum/editor/shared/services";

export function EditorIframeStatusCard({
  controls,
}: {
  controls: EditorIframeStatusCardControls;
}) {
  const t = useI18n();
  const title =
    controls.status === "idle"
      ? t["com.myoxus.editor.embed.idle-hint"]()
      : controls.status === "loading"
        ? t["com.myoxus.loading"]()
        : t["com.myoxus.editor.embed.load-error"]();
  const card = (
    <SurfaceListItem
      component="div"
      appearance="card"
      selected={controls.selected}
      fullHeight
      data-testid="editor-iframe-status-card"
      aria-busy={controls.status === "loading"}
    >
      <Stack gap="xs" miw={0}>
        <Group wrap="nowrap" gap="xs">
          {controls.status === "loading" ? (
            <Loading />
          ) : controls.status === "error" ? (
            <WarningIcon />
          ) : (
            <EmbedIcon />
          )}
          <MyoxusText truncate title={title}>
            <strong>{title}</strong>
          </MyoxusText>
          {controls.status === "error" ? (
            <Group wrap="nowrap" gap="xs">
              {!controls.readonly ? (
                <IconButton
                  icon={<EditIcon />}
                  tooltip={t["Edit"]()}
                  onClick={(event) => {
                    event.stopPropagation();
                    controls.edit(event.currentTarget);
                  }}
                />
              ) : null}
              <IconButton
                icon={<ResetIcon />}
                tooltip={t["com.myoxus.editor.toolbar.reload"]()}
                onClick={(event) => {
                  event.stopPropagation();
                  void controls.retry();
                }}
              />
            </Group>
          ) : null}
        </Group>
        {controls.status === "error" && controls.message ? (
          <MyoxusText tone="secondary" truncate title={controls.message}>
            {controls.message}
          </MyoxusText>
        ) : null}
      </Stack>
    </SurfaceListItem>
  );
  // Persisted canvas bounds stay with the renderer; Page follows the approved compact-card pattern.
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
