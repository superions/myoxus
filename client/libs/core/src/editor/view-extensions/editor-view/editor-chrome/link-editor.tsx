// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DoneIcon, LinkIcon, TextIcon } from "@myoxus/icons/react";
import { Group, IconButton, Input, Stack, Tooltip } from "@myoxus/ui-facade";
import type { EditorLinkEditorControls } from "@virgultum/editor/shared/services";
import { useState } from "react";
import { EditorInlinePopup } from "./inline-popup";

export function EditorLinkEditor({
  controls,
}: {
  controls: EditorLinkEditorControls;
}) {
  const t = useI18n();
  const [url, setUrl] = useState(controls.url);
  const [text, setText] = useState(controls.text);
  const label = t["com.myoxus.editor.keyboard.link"]();
  const textLabel = t["Text"]();
  return (
    <EditorInlinePopup
      controls={controls}
      label={label}
      onSubmit={() => controls.confirm(url, text)}
    >
      <Group wrap="nowrap" align="end">
        <Stack>
          {controls.editing ? (
            <Input
              aria-label={textLabel}
              preFix={
                <Tooltip content={textLabel}>
                  <TextIcon aria-hidden />
                </Tooltip>
              }
              placeholder={t["com.myoxus.editor.link.input-text"]()}
              value={text}
              onChange={setText}
              autoFocus
              autoSelect
              data-autofocus
            />
          ) : null}
          <Input
            aria-label={label}
            preFix={
              <Tooltip content={label}>
                <LinkIcon aria-hidden />
              </Tooltip>
            }
            placeholder={t["com.myoxus.editor.link.input-link"]()}
            value={url}
            onChange={setUrl}
            spellCheck={false}
            autoFocus={!controls.editing}
            data-autofocus={controls.editing ? undefined : true}
          />
        </Stack>
        <IconButton
          type="submit"
          icon={<DoneIcon />}
          tooltip={t["Save"]()}
          disabled={!controls.isValidUrl(url)}
        />
      </Group>
    </EditorInlinePopup>
  );
}
