// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  BlockLinkIcon,
  LinkIcon,
  ResetIcon,
  WarningIcon,
} from "@myoxus/icons/react";
import {
  Box,
  Grid,
  Group,
  IconButton,
  Loading,
  MyoxusText,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import type { EditorDocumentCardControls } from "@virgultum/editor/shared/services";

export function EditorDocumentCard({
  controls,
}: {
  controls: EditorDocumentCardControls;
}) {
  const t = useI18n();
  const label = controls.loading
    ? t["Loading"]()
    : controls.title || t["com.myoxus.reference.target-unavailable"]();
  const status = controls.error
    ? t["com.myoxus.editor.embed.load-error"]()
    : controls.deleted
      ? t["Deleted"]()
      : controls.unavailable
        ? t["com.myoxus.reference.target-unavailable"]()
        : controls.empty
          ? t["com.myoxus.common.preview-unavailable"]()
          : "";
  const compact = controls.variant === "list" || controls.variant === "cube";
  const fixed = controls.variant === "vertical" || controls.variant === "cube";
  const card = (
    <SurfaceListItem
      component="div"
      appearance="card"
      selected={controls.selected}
      fullHeight={controls.inSurface || fixed}
      data-testid="editor-document-card"
      aria-busy={controls.loading}
    >
      <Stack gap="xs" miw={0} h="100%">
        <Group wrap="nowrap" gap="xs">
          {controls.loading ? (
            <Loading />
          ) : controls.error ? (
            <WarningIcon />
          ) : controls.nodeReference ? (
            <BlockLinkIcon />
          ) : (
            <LinkIcon />
          )}
          <MyoxusText
            truncate
            title={label}
            data-testid="editor-document-card-title"
            className={
              controls.kind === "synced"
                ? "myoxus-embed-synced-doc-card-content-title-text"
                : "myoxus-embed-linked-doc-content-title-text"
            }
          >
            <strong>{label}</strong>
          </MyoxusText>
        </Group>
        {!compact && controls.description ? (
          <MyoxusText
            lineClamp={controls.variant === "vertical" ? undefined : 2}
            preserveWhitespace
            data-testid="editor-document-card-description"
            className="myoxus-embed-linked-doc-content-note alias"
          >
            {controls.description}
          </MyoxusText>
        ) : !compact && status && status !== label ? (
          <MyoxusText tone={controls.error ? "danger" : "secondary"}>
            {status}
          </MyoxusText>
        ) : null}
        <Box
          flex={1}
          mih={0}
          ref={controls.mountPreview}
          hidden={
            compact || !!controls.description || !!status || controls.loading
          }
        />
        {controls.mountBanner && (
          <Box ref={controls.mountBanner} hidden={!controls.showBanner} />
        )}
        <Group wrap="nowrap" gap="xs">
          {controls.error ? (
            <IconButton
              icon={<ResetIcon />}
              tooltip={t["com.myoxus.editor.toolbar.reload"]()}
              onClick={(event) => {
                event.stopPropagation();
                controls.reload();
              }}
            />
          ) : controls.updated ? (
            <MyoxusText typographySlot="caption" tone="secondary" truncate>
              {t["Updated"]()} {controls.updated}
            </MyoxusText>
          ) : null}
        </Group>
      </Stack>
    </SurfaceListItem>
  );
  // Canvas dimensions belong to the persisted block; Page cards follow their content.
  return controls.inSurface ? (
    card
  ) : (
    <Grid>
      <Grid.Col
        span="content"
        maw="50%"
        h={fixed ? controls.height : undefined}
        w={fixed ? controls.width : undefined}
      >
        {card}
      </Grid.Col>
    </Grid>
  );
}
