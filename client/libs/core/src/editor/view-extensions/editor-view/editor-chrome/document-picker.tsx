// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  CommandCombobox,
  Group,
  MyoxusLoader,
  Scrollable,
  Text,
  Tooltip,
  useCommandCombobox,
  popoverViewportMiddlewares,
} from "@myoxus/ui-facade";
import type { EditorDocumentPickerControls } from "@virgultum/editor/shared/services";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  DocumentPickerIcon,
  DocumentPickerLabel,
} from "./document-picker-item";

/** No extra input: typing and focus remain in the document's existing inline editor. */
export function EditorDocumentPicker({
  controls,
}: {
  controls: EditorDocumentPickerControls;
}) {
  const snapshot = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
  );
  const store = useCommandCombobox({
    opened: snapshot.open && snapshot.groups.length > 0,
  });
  const listId = useId();
  const active = useRef<string | undefined>(undefined);
  const t = useI18n();
  const items = useMemo(
    () => snapshot.groups.flatMap((group) => group.items),
    [snapshot],
  );
  const syncActive = useCallback(() => {
    const item = items[store.getSelectedOptionIndex()];
    active.current = item?.id;
    if (item) {
      controls.input.setAttribute("aria-activedescendant", listId + item.id);
      controls.activate(item.id);
    } else controls.input.removeAttribute("aria-activedescendant");
  }, [controls, items, listId, store]);

  useLayoutEffect(() => {
    const input = controls.input;
    const attrs = [
      "role",
      "aria-autocomplete",
      "aria-controls",
      "aria-expanded",
      "aria-activedescendant",
    ];
    const previous = attrs.map((key) => input.getAttribute(key));
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-expanded", "true");
    return () =>
      attrs.forEach((key, index) => {
        if (previous[index] === null) input.removeAttribute(key);
        else input.setAttribute(key, previous[index]);
      });
  }, [controls, listId]);

  // Portals can attach after the parent layout effect when async results first open the list.
  const selectPreferred = useCallback(
    (list: HTMLDivElement | null) => {
      if (!list) return;
      store.setListId(listId);
      const wanted = snapshot.preferredId ?? active.current;
      const index = items.findIndex(
        (item) => item.id === wanted && !item.disabled,
      );
      store.selectOption(
        index < 0 ? items.findIndex((item) => !item.disabled) : index,
      );
      syncActive();
    },
    [snapshot.preferredId, items, listId, store, syncActive],
  );

  useLayoutEffect(
    () =>
      controls.subscribeKeys((event) => {
        const { key, shiftKey, ctrlKey, metaKey, altKey } = event;
        const plain = !ctrlKey && !metaKey && !altKey;
        const command = (ctrlKey || metaKey) && !altKey && !shiftKey;
        if (
          (plain && key === "ArrowDown" && !shiftKey) ||
          (plain && key === "Tab" && !shiftKey) ||
          (command && key.toLowerCase() === "n")
        )
          store.selectNextOption();
        else if (
          (plain && key === "ArrowUp" && !shiftKey) ||
          (plain && key === "Tab" && shiftKey) ||
          (command && key.toLowerCase() === "p")
        )
          store.selectPreviousOption();
        else if (plain && key === "Enter" && !shiftKey)
          store.clickSelectedOption();
        else return;
        syncActive();
        event.preventDefault();
        event.stopPropagation();
      }),
    [controls, store, syncActive],
  );

  return (
    <CommandCombobox
      store={store}
      onOptionSubmit={controls.choose}
      onDismiss={controls.cancel}
      clickOutsideCapture
      position="bottom-start"
      size="xs"
      preventPositionChangeWhenVisible={false}
      middlewares={popoverViewportMiddlewares}
      width="max-content"
    >
      <CommandCombobox.DropdownTarget>
        <span ref={controls.setAnchor} />
      </CommandCombobox.DropdownTarget>
      <CommandCombobox.Dropdown
        // A previous viewport cap must not constrain a newly grown async list before native flip measures it.
        key={snapshot.query + ":" + snapshot.groups.length + ":" + items.length}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Scrollable.Viewport
          autosize
          maxHeight="floating"
          scrollbars="y"
          tabIndex={-1}
        >
          <CommandCombobox.Options
            ref={selectPreferred}
            id={listId}
            aria-label={
              snapshot.query
                ? t["com.myoxus.editor.at-menu.link-to-doc"]({
                    query: snapshot.query,
                  })
                : t["com.myoxus.editor.at-menu.recent-docs"]()
            }
            data-testid="document-picker"
          >
            {snapshot.groups.map((group) => (
              <CommandCombobox.Group
                key={group.id}
                label={
                  <Group wrap="nowrap">
                    {group.name}
                    {group.loading ? <MyoxusLoader /> : null}
                  </Group>
                }
              >
                {!group.items.length && group.emptyMessage && !group.loading ? (
                  <CommandCombobox.Empty>
                    {group.emptyMessage}
                  </CommandCombobox.Empty>
                ) : null}
                {group.items.map((item) => (
                  <Tooltip key={item.id} content={item.name} side="right">
                    <CommandCombobox.Option
                      value={item.id}
                      id={listId + item.id}
                      disabled={item.disabled}
                      aria-label={item.name}
                      onMouseMove={() => {
                        store.selectOption(items.indexOf(item));
                        syncActive();
                      }}
                    >
                      <Group wrap="nowrap">
                        <DocumentPickerIcon item={item} />
                        <Text span inherit truncate c="inherit">
                          <DocumentPickerLabel item={item} />
                        </Text>
                      </Group>
                    </CommandCombobox.Option>
                  </Tooltip>
                ))}
              </CommandCombobox.Group>
            ))}
          </CommandCombobox.Options>
        </Scrollable.Viewport>
      </CommandCombobox.Dropdown>
    </CommandCombobox>
  );
}
