// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  EditIcon,
  EmbedIcon,
  ResetIcon,
  WarningIcon,
} from "@myoxus/icons/react";
import { IconButton, Loading, ReferenceCard } from "@myoxus/ui-facade";
import type { EditorIframeStatusCardControls } from "@virgultum/editor/shared/services";

export function EditorIframeStatusCard({
  controls: c,
}: {
  controls: EditorIframeStatusCardControls;
}) {
  const t = useI18n();
  const title =
    c.status === "idle"
      ? t["com.myoxus.editor.embed.idle-hint"]()
      : c.status === "loading"
        ? t["com.myoxus.loading"]()
        : t["com.myoxus.editor.embed.load-error"]();
  return (
    <ReferenceCard
      size="small"
      contained={c.inSurface}
      selected={c.selected}
      fullHeight={c.inSurface}
      title={title}
      metadata={c.status === "error" ? c.message : undefined}
      icon={
        c.status === "loading" ? (
          <Loading />
        ) : c.status === "error" ? (
          <WarningIcon />
        ) : (
          <EmbedIcon />
        )
      }
      actions={
        c.status === "error" ? (
          <>
            {!c.readonly ? (
              <IconButton
                icon={<EditIcon />}
                tooltip={t.Edit()}
                onClick={(event) => {
                  event.stopPropagation();
                  c.edit(event.currentTarget);
                }}
              />
            ) : null}
            <IconButton
              icon={<ResetIcon />}
              tooltip={t["com.myoxus.editor.toolbar.reload"]()}
              onClick={(event) => {
                event.stopPropagation();
                void c.retry();
              }}
            />
          </>
        ) : undefined
      }
      data-testid="editor-iframe-status-card"
      aria-busy={c.status === "loading"}
    />
  );
}
