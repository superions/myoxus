// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DoneIcon, ResetIcon, TextIcon } from "@myoxus/icons/react";
import { Group, IconButton, Input, Tooltip } from "@myoxus/ui-facade";
import type { EditorReferenceEditorControls } from "@virgultum/editor/shared/services";
import { useState } from "react";
import { EditorInlinePopup } from "./inline-popup";

export function EditorReferenceEditor({
  controls,
}: {
  controls: EditorReferenceEditorControls;
}) {
  const t = useI18n();
  const [title, setTitle] = useState(controls.title);
  const label = t["com.myoxus.editor.reference.add-custom-title"]();
  return (
    <EditorInlinePopup
      controls={controls}
      label={label}
      onSubmit={() => controls.confirm(title)}
    >
      <Group wrap="nowrap">
        <Input
          aria-label={label}
          preFix={
            <Tooltip content={label}>
              <TextIcon aria-hidden />
            </Tooltip>
          }
          placeholder={label}
          value={title}
          onChange={setTitle}
          autoFocus
          autoSelect
          data-autofocus
        />
        <IconButton
          type="button"
          icon={<ResetIcon />}
          tooltip={t["com.myoxus.editor.reference.reset"]()}
          onClick={controls.reset}
        />
        <IconButton
          type="submit"
          icon={<DoneIcon />}
          tooltip={t["Save"]()}
          disabled={!title.trim()}
        />
      </Group>
    </EditorInlinePopup>
  );
}
