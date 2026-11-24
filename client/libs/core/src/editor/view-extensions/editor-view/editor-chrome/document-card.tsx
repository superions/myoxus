// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  BlockLinkIcon,
  DeleteIcon,
  LinkIcon,
  ResetIcon,
  WarningIcon,
} from "@myoxus/icons/react";
import {
  Box,
  Grid,
  IconButton,
  Loading,
  MyoxusText,
  ReferenceCard,
  Badge,
} from "@myoxus/ui-facade";
import type { EditorDocumentCardControls } from "@virgultum/editor/shared/services";

export function EditorDocumentCard({
  controls: c,
}: {
  controls: EditorDocumentCardControls;
}) {
  const t = useI18n();
  if (c.citationIdentifier !== undefined) {
    const Icon =
      c.citationIcon && { LinkIcon, BlockLinkIcon, DeleteIcon }[c.citationIcon];
    return (
      <ReferenceCard
        size="small"
        contained={c.inSurface}
        selected={c.selected}
        title={c.title}
        icon={Icon && <Icon width="1.25em" height="1.25em" />}
        status={
          <Badge tone={c.selected ? "info" : "neutral"}>
            {c.citationIdentifier}
          </Badge>
        }
        data-testid="editor-document-card"
      />
    );
  }

  const label = c.loading
    ? t.Loading()
    : c.title || t["com.myoxus.reference.target-unavailable"]();
  const status = c.error
    ? t["com.myoxus.editor.embed.load-error"]()
    : c.deleted
      ? t.Deleted()
      : c.unavailable
        ? t["com.myoxus.reference.target-unavailable"]()
        : c.empty
          ? t["com.myoxus.common.preview-unavailable"]()
          : "";
  const compact = c.variant === "list" || c.variant === "cube";
  const fixed = c.variant === "vertical" || c.variant === "cube";
  const card = (
    <ReferenceCard
      size={compact ? "small" : "large"}
      orientation={fixed ? "vertical" : "horizontal"}
      contained={c.inSurface || fixed}
      selected={c.selected}
      fullHeight={c.inSurface || fixed}
      title={label}
      metadata={
        compact && !c.error && c.updated
          ? t.Updated() + " " + c.updated
          : undefined
      }
      icon={
        c.loading ? (
          <Loading />
        ) : c.error ? (
          <WarningIcon />
        ) : c.nodeReference ? (
          <BlockLinkIcon />
        ) : (
          <LinkIcon />
        )
      }
      description={
        !compact && c.description ? (
          c.description
        ) : !compact && status && status !== label ? (
          <MyoxusText tone={c.error ? "danger" : "secondary"}>
            {status}
          </MyoxusText>
        ) : undefined
      }
      footer={
        c.error ? (
          <IconButton
            icon={<ResetIcon />}
            tooltip={t["com.myoxus.editor.toolbar.reload"]()}
            onClick={(event) => {
              event.stopPropagation();
              c.reload();
            }}
          />
        ) : !compact && c.updated ? (
          <MyoxusText typographySlot="caption" tone="secondary" truncate>
            {t.Updated()} {c.updated}
          </MyoxusText>
        ) : undefined
      }
      data-testid="editor-document-card"
      aria-busy={c.loading}
    >
      {/* These renderer-owned mounts stay present across resource, metadata and selection updates. */}
      <Box
        key="preview"
        flex={1}
        mih={0}
        ref={c.mountPreview}
        hidden={compact || !!c.description || !!status || c.loading}
      />
      {c.mountBanner ? (
        <Box key="banner" ref={c.mountBanner} hidden={!c.showBanner} />
      ) : null}
    </ReferenceCard>
  );
  if (c.inSurface || !fixed) return card;
  // Fixed Page variants retain their renderer-owned height; the shared size owns normal Page width.
  return (
    <Grid gap={0}>
      <Grid.Col span="content" maw="50%" h={c.height} w={c.width}>
        {card}
      </Grid.Col>
    </Grid>
  );
}
