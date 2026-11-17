// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Menu } from "@myoxus/ui-facade";
import type { EditorActionMenuControls } from "@virgultum/editor/shared/services";
import { SelectionActions } from "./selection-toolbar/block-actions";
import { renderControl } from "./selection-toolbar";

export function EditorActionMenu({
  controls,
}: {
  controls: EditorActionMenuControls;
}) {
  return (
    <Menu
      contentRef={controls.menuRef}
      rootOptions={{
        open: true,
        onClose: controls.close,
        // The popup's owning editor restores its retained caret after unmount.
        returnFocus: false,
        closeOnItemClick: false,
        clickOutsideEvents: ["click"],
      }}
      contentOptions={{
        side: "bottom",
        align: "start",
        "aria-label": controls.label,
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
