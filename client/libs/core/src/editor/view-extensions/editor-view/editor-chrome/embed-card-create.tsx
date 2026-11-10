// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DoneIcon, LinkIcon } from "@myoxus/icons/react";
import {
  Box,
  Group,
  IconButton,
  Input,
  Modal,
  Tooltip,
} from "@myoxus/ui-facade";
import type { EditorEmbedCardCreateControls } from "@virgultum/editor/shared/services";
import { useState } from "react";

export function EditorEmbedCardCreate({
  controls,
}: {
  controls: EditorEmbedCardCreateControls;
}) {
  const t = useI18n();
  const [url, setUrl] = useState("");
  const label = t["com.myoxus.editor.embed.input-link"]();
  return (
    <Modal
      open
      width="xs"
      title={controls.title}
      description={controls.description}
      returnFocus={false}
      onOpenChange={(open) => {
        if (!open) controls.close();
      }}
      onEscape={(event) => {
        event.stopPropagation();
        controls.close();
      }}
    >
      <span ref={controls.setAnchor} aria-hidden />
      <Box
        component="form"
        data-range-sync-exclude="true"
        onPointerDown={(event) => event.stopPropagation()}
        onCopy={(event) => event.stopPropagation()}
        onCut={(event) => event.stopPropagation()}
        onPaste={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "Tab") event.stopPropagation();
          if (event.key === "Enter" && event.nativeEvent.isComposing)
            event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          controls.confirm(url);
        }}
      >
        <Group wrap="nowrap" gap="xs">
          <Input
            value={url}
            onChange={setUrl}
            aria-label={label}
            placeholder={label}
            autoFocus
            data-autofocus
            preFix={
              <Tooltip content={label}>
                <LinkIcon aria-hidden />
              </Tooltip>
            }
          />
          <IconButton
            type="submit"
            icon={<DoneIcon />}
            tooltip={t["Confirm"]()}
            disabled={!controls.isValidUrl(url)}
          />
        </Group>
      </Box>
    </Modal>
  );
}
