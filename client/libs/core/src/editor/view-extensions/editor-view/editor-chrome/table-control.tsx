// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { KeyboardEvent } from "react";
import { IconButton } from "@myoxus/ui-facade";
import type { EditorTableControl as Controls } from "@virgultum/core/services";
import { editorGlyph } from "./glyphs";

function stopTableKey(event: KeyboardEvent) {
  if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
}

export function EditorTableControl({ controls }: { controls: Controls }) {
  const { action, menu, setElement } = controls;
  return (
    <IconButton
      ref={setElement}
      data-testid={action.id}
      data-range-sync-exclude="true"
      aria-label={action.label}
      aria-haspopup={menu ? "menu" : undefined}
      tooltip={action.label}
      disabled={action.disabled}
      // Native activation and Tab stay local; editor command shortcuts still bubble.
      onKeyDown={stopTableKey}
      onKeyUp={stopTableKey}
      onKeyPress={stopTableKey}
      onMouseDown={(event) => {
        if (!controls.mouseDown) return;
        event.stopPropagation();
        controls.mouseDown(event.currentTarget, event.nativeEvent);
      }}
      onClick={(event) => {
        event.stopPropagation();
        action.run?.(event.currentTarget, event.nativeEvent);
      }}
    >
      {editorGlyph(action.icon)}
    </IconButton>
  );
}
