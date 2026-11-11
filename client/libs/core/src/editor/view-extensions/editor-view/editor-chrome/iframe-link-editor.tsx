// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { CloseIcon, LinkIcon } from "@myoxus/icons/react";
import {
  Button,
  Group,
  IconButton,
  Input,
  MyoxusText,
  Stack,
  Tooltip,
} from "@myoxus/ui-facade";
import type { EditorIframeLinkEditorControls } from "@virgultum/editor/shared/services";
import { useState } from "react";
import { EditorInlinePopup } from "./inline-popup";

export function EditorIframeLinkEditor({
  controls,
}: {
  controls: EditorIframeLinkEditorControls;
}) {
  const t = useI18n();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const label = t["com.myoxus.editor.keyboard.link"]();
  const title = controls.title ?? t["com.myoxus.editor.embed.title"]();
  const submit = async () => {
    if (busy || !url.trim()) return;
    setBusy(true);
    try {
      await controls.confirm(url);
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditorInlinePopup
      controls={controls}
      label={controls.editing ? label : title}
      onSubmit={() => {
        void submit();
      }}
    >
      <Stack>
        {!controls.editing || controls.showCloseButton ? (
          <Group justify="space-between" wrap="nowrap">
            <MyoxusText>
              <strong>{controls.editing ? label : title}</strong>
            </MyoxusText>
            {controls.showCloseButton ? (
              <IconButton
                icon={<CloseIcon />}
                tooltip={t["Close"]()}
                onClick={controls.close}
              />
            ) : null}
          </Group>
        ) : null}
        {!controls.editing ? (
          <MyoxusText tone="secondary">
            {controls.description ??
              t["com.myoxus.editor.embed.works-with-links"]()}
          </MyoxusText>
        ) : null}
        <Input
          aria-label={label}
          value={url}
          onChange={setUrl}
          placeholder={
            controls.placeholder ?? t["com.myoxus.editor.embed.paste-link"]()
          }
          autoFocus
          data-autofocus
          spellCheck={false}
          preFix={
            <Tooltip content={label}>
              <LinkIcon aria-hidden />
            </Tooltip>
          }
        />
        <Group justify="end">
          <Button type="submit" disabled={busy || !url.trim()}>
            {t["Save"]()}
          </Button>
        </Group>
      </Stack>
    </EditorInlinePopup>
  );
}
