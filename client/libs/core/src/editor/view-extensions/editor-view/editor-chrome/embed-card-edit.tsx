// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { EditIcon, TextIcon } from "@myoxus/icons/react";
import {
  Button,
  Group,
  Input,
  Stack,
  Textarea,
  Tooltip,
} from "@myoxus/ui-facade";
import type { EditorEmbedCardEditControls } from "@virgultum/editor/shared/services";
import { useState } from "react";
import { EditorInlinePopup } from "./inline-popup";

export function EditorEmbedCardEdit({
  controls,
}: {
  controls: EditorEmbedCardEditControls;
}) {
  const t = useI18n();
  const [title, setTitle] = useState(controls.title);
  const [description, setDescription] = useState(controls.description);
  const titleLabel = controls.internal
    ? t["com.myoxus.editor.embed.title-alias"]()
    : t["com.myoxus.editor.embed.title-placeholder"]();
  const descriptionLabel = controls.internal
    ? t["com.myoxus.editor.embed.description-alias"]()
    : t["com.myoxus.editor.embed.description-placeholder"]();
  return (
    <EditorInlinePopup
      controls={controls}
      label={t["com.myoxus.editor.toolbar.edit-description"]()}
      position="top-start"
      contentMeasure="reading"
      onSubmit={() => controls.confirm(title, description)}
    >
      <Stack>
        <Input
          aria-label={titleLabel}
          placeholder={titleLabel}
          value={title}
          onChange={setTitle}
          autoFocus
          autoSelect
          data-autofocus
          preFix={
            <Tooltip content={titleLabel}>
              <TextIcon aria-hidden />
            </Tooltip>
          }
        />
        <Textarea
          aria-label={descriptionLabel}
          placeholder={descriptionLabel}
          value={description}
          onChange={setDescription}
          autosize
          minRows={3}
          maxRows={6}
          maxLength={500}
          leftSection={
            <Tooltip content={descriptionLabel}>
              <EditIcon aria-hidden />
            </Tooltip>
          }
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              controls.confirm(title, description);
            }
          }}
        />
        <Group justify={controls.mode === "external" ? "end" : "space-between"}>
          {controls.mode === "linked" ? (
            <Button
              variant="secondary"
              disabled={!controls.canReset}
              onClick={controls.reset}
            >
              {t["com.myoxus.editor.reference.reset"]()}
            </Button>
          ) : null}
          {controls.mode === "synced" ? (
            <Button variant="secondary" onClick={controls.close}>
              {t["Cancel"]()}
            </Button>
          ) : null}
          <Button variant="primary" type="submit" disabled={!title.trim()}>
            {t["Save"]()}
          </Button>
        </Group>
      </Stack>
    </EditorInlinePopup>
  );
}
