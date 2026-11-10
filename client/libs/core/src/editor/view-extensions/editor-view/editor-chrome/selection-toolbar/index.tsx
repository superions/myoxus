// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useI18n } from "@myoxus/i18n";
import { MoreVerticalIcon } from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  Menu,
  Popover,
  PopoverContent,
  PopoverTarget,
  Divider,
} from "@myoxus/ui-facade";
import type {
  EditorSelectionControls,
  SelectionAction,
} from "@virgultum/editor/shared/services";
import { type PointerEvent, useSyncExternalStore } from "react";
import { SelectionActions } from "./block-actions";
import { TextFormatControl } from "./text-format";
import { SurfacePropertyControl } from "./surface-property";

export function renderControl(action: SelectionAction, menu: boolean) {
  return action.control?.type === "choice" ||
    action.control?.type === "toggle" ? (
    <TextFormatControl action={action} labelled={menu} />
  ) : (
    <SurfacePropertyControl action={action} compact={!menu} />
  );
}
/** One portal under the owning editor tree; selection geometry stays in Virgultum. */
export function EditorSelectionToolbar({
  controls,
}: {
  controls: EditorSelectionControls;
}) {
  const state = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
    controls.getSnapshot,
  );
  const t = useI18n();
  const preserveSelection = (event: PointerEvent) => {
    event.stopPropagation();
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("input,select,textarea,[contenteditable='true']")
    )
      event.preventDefault();
  };
  return (
    <Popover
      opened={state.open}
      onChange={(opened) => {
        if (!opened) controls.dismiss();
      }}
      position={state.placement}
      floatingStrategy="fixed"
      fitViewport
      returnFocus={false}
      trapFocus={false}
      closeOnEscape={false}
      closeOnClickOutside={false}
    >
      <PopoverTarget>
        <span aria-hidden ref={controls.setAnchor} />
      </PopoverTarget>
      <PopoverContent
        ref={controls.setFloating}
        role="toolbar"
        aria-label={t["com.myoxus.editor.toolbar.selection"]()}
        data-testid="selection-toolbar"
        data-range-sync-exclude="true"
        onPointerDown={preserveSelection}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            event.target instanceof Element &&
            !event.target.closest("[role=menu],[role=listbox]") &&
            event.target.closest("[data-myoxus-ui-role=popover-content]") ===
              event.currentTarget
          ) {
            event.stopPropagation();
            controls.dismiss();
          }
        }}
      >
        <Group key={state.key}>
          <SelectionActions
            actions={state.primary}
            renderControl={renderControl}
          />
          {state.more.length ? (
            <>
              <Divider orientation="vertical" />
              <Menu
                noPortal
                items={
                  <SelectionActions
                    actions={state.more}
                    menu
                    renderControl={renderControl}
                  />
                }
              >
                <IconButton
                  aria-label={t["com.myoxus.editor.toolbar.more"]()}
                  tooltip={t["com.myoxus.editor.toolbar.more"]()}
                  icon={<MoreVerticalIcon />}
                />
              </Menu>
            </>
          ) : null}
        </Group>
      </PopoverContent>
    </Popover>
  );
}
