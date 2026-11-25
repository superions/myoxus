// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { useI18n } from "@myoxus/i18n";
import { MoreVerticalIcon } from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  Menu,
  type MenuRef,
  Popover,
  PopoverContent,
  PopoverTarget,
  Divider,
} from "@myoxus/ui-facade";
import type {
  EditorSelectionControls,
  SelectionAction,
} from "@virgultum/editor/shared/services";
import { type PointerEvent, useRef, useSyncExternalStore } from "react";
import { SelectionActions } from "./block-actions";
import { TextFormatControl } from "./text-format";
import { SurfacePropertyControl } from "./surface-property";

export function renderControl(
  action: SelectionAction,
  menu: boolean,
  afterAction?: () => void,
) {
  return action.control?.type === "choice" ||
    action.control?.type === "toggle" ? (
    <TextFormatControl action={action} labelled={menu} />
  ) : (
    <SurfacePropertyControl
      action={action}
      compact={!menu}
      afterAction={afterAction}
    />
  );
}
/** One portal under the owning editor tree; selection geometry stays in Virgultum. */
export function EditorSelectionToolbar({
  controls,
  openMore,
}: {
  controls: EditorSelectionControls;
  openMore?: () => void;
}) {
  const state = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
    controls.getSnapshot,
  );
  const t = useI18n();
  const moreMenu = useRef<MenuRef>(null);
  // A dismissed canvas toolbar must stop intercepting gestures immediately.
  if (!state.open) return null;
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
            afterAction={controls.activate}
            renderControl={renderControl}
          />
          {openMore ? (
            <>
              <Divider orientation="vertical" />
              <IconButton
                data-testid="selection-more"
                aria-label={t["com.myoxus.editor.toolbar.more"]()}
                tooltip={t["com.myoxus.editor.toolbar.more"]()}
                icon={<MoreVerticalIcon />}
                onClick={openMore}
              />
            </>
          ) : state.more.length ? (
            <>
              <Divider orientation="vertical" />
              <Menu
                ref={moreMenu}
                noPortal
                rootOptions={{
                  returnFocus: false,
                  onClose: () => requestAnimationFrame(controls.activate),
                }}
                items={
                  <SelectionActions
                    actions={state.more}
                    menu
                    afterAction={() => moreMenu.current?.changeOpen(false)}
                    renderControl={renderControl}
                  />
                }
              >
                <IconButton
                  data-testid="selection-more"
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
