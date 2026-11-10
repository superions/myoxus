// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { Menu } from "@myoxus/ui-facade";
import type { EditorTableMenuControls } from "@virgultum/editor/shared/services";
import { SelectionActions } from "./selection-toolbar/block-actions";
import { renderControl } from "./selection-toolbar";

export function EditorTableMenu({
  controls,
}: {
  controls: EditorTableMenuControls;
}) {
  const t = useI18n();
  return (
    <Menu
      rootOptions={{
        open: true,
        onClose: controls.close,
        closeOnItemClick: false,
        clickOutsideEvents: ["click"],
      }}
      contentOptions={{
        side: "bottom",
        align: "start",
        "aria-label": t["com.myoxus.editor.slash.table"](),
        "data-range-sync-exclude": "true",
        onPointerDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
        onKeyDown: (event) => {
          if (event.key !== "Tab") event.stopPropagation();
        },
      }}
      items={
        <SelectionActions
          actions={controls.actions}
          menu
          renderControl={renderControl}
        />
      }
    >
      <span aria-hidden ref={controls.setAnchor} />
    </Menu>
  );
}
