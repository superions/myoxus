// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { IconPicker } from "@myoxus/ui-facade";
import type { EditorIconPickerControls } from "@virgultum/editor/shared/services";

import { EditorInlinePopup } from "./inline-popup";

export function EditorIconPickerPopup({
  controls,
}: {
  controls: EditorIconPickerControls;
}) {
  const t = useI18n();
  return (
    <EditorInlinePopup
      controls={controls}
      label={t["com.myoxus.icon-picker.select-icon"]()}
      onSubmit={() => {}}
    >
      <IconPicker
        onSelect={(icon) => {
          controls.onSelect(icon);
          controls.close();
        }}
      />
    </EditorInlinePopup>
  );
}
