// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { AttachmentIcon, ResetIcon, WarningIcon } from "@myoxus/icons/react";
import {
  Grid,
  Group,
  IconButton,
  Loading,
  MyoxusText,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import type { EditorAttachmentCardControls } from "@virgultum/editor/shared/services";

/** Resource state and writes stay with the mounted editor block. */
export function EditorAttachmentCard({
  controls,
}: {
  controls: EditorAttachmentCardControls;
}) {
  const t = useI18n();
  // File-type artwork includes a small extension label; keep it legible at native text scale.
  const FileIcon = getAttachmentFileIconRC(controls.fileType);
  const content = (
    <Stack gap="xs" miw={0}>
      <Group wrap="nowrap" gap="xs">
        {controls.loading ? (
          <Loading />
        ) : controls.error ? (
          <WarningIcon />
        ) : (
          <AttachmentIcon />
        )}
        <MyoxusText truncate title={controls.title}>
          <strong>{controls.title}</strong>
        </MyoxusText>
      </Group>
      <Group wrap="nowrap" gap="xs">
        <MyoxusText tone="secondary" truncate title={controls.description}>
          {controls.description}
        </MyoxusText>
        {controls.action && (
          <IconButton
            icon={
              controls.action.kind === "limit" ? <WarningIcon /> : <ResetIcon />
            }
            tooltip={
              controls.action.kind === "retry"
                ? t["Retry"]()
                : controls.action.kind === "reload"
                  ? t["com.myoxus.editor.toolbar.reload"]()
                  : t["Info"]()
            }
            onClick={(event) => {
              event.stopPropagation();
              controls.action?.run();
            }}
          />
        )}
      </Group>
    </Stack>
  );
  return (
    <Grid>
      <Grid.Col
        span={controls.inSurface ? 12 : "content"}
        maw={controls.inSurface ? undefined : "50%"}
      >
        <SurfaceListItem
          component="div"
          appearance="card"
          selected={controls.selected}
          fullHeight
          data-testid="editor-attachment-card"
          aria-busy={controls.loading}
        >
          {controls.vertical ? (
            <Stack>
              <FileIcon width="2em" height="2em" />
              {content}
            </Stack>
          ) : (
            <Group wrap="nowrap" justify="space-between">
              {content}
              <FileIcon width="2em" height="2em" />
            </Group>
          )}
        </SurfaceListItem>
      </Grid.Col>
    </Grid>
  );
}
