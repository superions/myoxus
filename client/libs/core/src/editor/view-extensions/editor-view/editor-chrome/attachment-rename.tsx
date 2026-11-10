// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DoneIcon, EditIcon } from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  Input,
  MyoxusText,
  Tooltip,
} from "@myoxus/ui-facade";
import type { EditorAttachmentRenameControls } from "@virgultum/editor/shared/services";
import { useState } from "react";
import { EditorInlinePopup } from "./inline-popup";

export function EditorAttachmentRename({
  controls,
}: {
  controls: EditorAttachmentRenameControls;
}) {
  const t = useI18n();
  const [name, setName] = useState(controls.name);
  const label = t["Rename"]();
  return (
    <EditorInlinePopup
      controls={controls}
      label={label}
      position="top-start"
      onSubmit={() => controls.confirm(name)}
    >
      <Group wrap="nowrap" gap="xs">
        <Input
          aria-label={label}
          value={name}
          onChange={setName}
          autoFocus
          autoSelect
          data-autofocus
          preFix={
            <Tooltip content={label}>
              <EditIcon aria-hidden />
            </Tooltip>
          }
        />
        {controls.extension ? (
          <MyoxusText tone="secondary">{controls.extension}</MyoxusText>
        ) : null}
        <IconButton type="submit" icon={<DoneIcon />} tooltip={t["Save"]()} />
      </Group>
    </EditorInlinePopup>
  );
}
