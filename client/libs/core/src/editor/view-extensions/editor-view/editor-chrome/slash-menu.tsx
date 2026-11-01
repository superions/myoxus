// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { getEditorGlyph } from "./glyphs";
import { ArrowRightSmallIcon, FileIcon } from "@myoxus/icons/react";
import {
  Button,
  CommandCombobox,
  Group,
  Scrollable,
  Tooltip,
  useCommandCombobox,
} from "@myoxus/ui-facade";
import type { EditorSlashControls } from "@virgultum/editor/shared/services";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";

/** A native command list; selection and document mutations stay in the scoped editor. */
export function EditorSlashMenu({
  controls,
}: {
  controls: EditorSlashControls;
}) {
  const snapshot = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
  );
  const store = useCommandCombobox({
    opened: snapshot.open && !snapshot.query.endsWith(" "),
  });
  const listId = useId();
  const t = useI18n();
  const syncActiveDescendant = useCallback(() => {
    const option = snapshot.options[store.getSelectedOptionIndex()];
    if (option)
      controls.input.setAttribute(
        "aria-activedescendant",
        listId + "-" + option.id,
      );
    else controls.input.removeAttribute("aria-activedescendant");
  }, [controls, listId, snapshot.options, store]);
  useLayoutEffect(() => {
    const input = controls.input;
    const attributes = [
      "role",
      "aria-autocomplete",
      "aria-controls",
      "aria-expanded",
      "aria-activedescendant",
    ];
    const previous = attributes.map((key) => input.getAttribute(key));
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", listId);
    input.setAttribute("aria-expanded", "true");
    return () =>
      attributes.forEach((key, index) => {
        const value = previous[index];
        if (value === null) input.removeAttribute(key);
        else input.setAttribute(key, value);
      });
  }, [controls, listId]);
  useLayoutEffect(() => {
    controls.input.setAttribute(
      "aria-expanded",
      String(!snapshot.query.endsWith(" ")),
    );
    return controls.subscribeKeys((event) => {
      const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
      const modified = ctrlKey || metaKey || altKey;
      let handled = true;
      if (
        (!modified && !shiftKey && key === "ArrowDown") ||
        (!modified && !shiftKey && key === "Tab") ||
        ((ctrlKey || metaKey) && !altKey && key.toLowerCase() === "n")
      )
        store.selectNextOption();
      else if (
        (!modified && !shiftKey && key === "ArrowUp") ||
        (!modified && shiftKey && key === "Tab") ||
        ((ctrlKey || metaKey) && !altKey && key.toLowerCase() === "p")
      )
        store.selectPreviousOption();
      else if (
        !modified &&
        !shiftKey &&
        key === "Enter" &&
        snapshot.options.length
      )
        store.clickSelectedOption();
      else if (!modified && key === "ArrowRight") {
        const option = snapshot.options[store.getSelectedOptionIndex()];
        if (option?.submenu) controls.choose(option.id);
      } else if (!modified && key === "ArrowLeft") {
        if (snapshot.depth) controls.back();
      } else handled = false;
      if (handled) {
        syncActiveDescendant();
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }, [
    controls,
    listId,
    snapshot.options,
    snapshot.query,
    snapshot.returnTo,
    snapshot.depth,
    store,
    syncActiveDescendant,
  ]);
  const groups = Map.groupBy(snapshot.options, (option) => option.group);
  return (
    <CommandCombobox
      store={store}
      onOptionSubmit={controls.choose}
      onDismiss={controls.cancel}
      position="bottom-start"
      floatingHeight="viewport"
      width="max-content"
    >
      <CommandCombobox.DropdownTarget>
        <span ref={controls.setAnchor} />
      </CommandCombobox.DropdownTarget>
      <CommandCombobox.Dropdown onMouseDown={(event) => event.preventDefault()}>
        <Scrollable.Viewport
          autosize
          maxHeight="var(--combobox-floating-options-max-height)"
          scrollbars="y"
          tabIndex={-1}
        >
          {snapshot.depth ? (
            <CommandCombobox.Header>
              <Button onClick={controls.back}>
                {t["common.back"]()} · {snapshot.heading}
              </Button>
            </CommandCombobox.Header>
          ) : null}
          <CommandCombobox.Options
            id={listId}
            ref={(element) => {
              if (element) {
                store.setListId(listId);
                store.selectOption(
                  Math.max(
                    0,
                    snapshot.options.findIndex(
                      (option) => option.id === snapshot.returnTo,
                    ),
                  ),
                );
                syncActiveDescendant();
              }
            }}
            aria-label={t["com.myoxus.actions"]()}
            data-testid="slash-menu"
            data-depth={snapshot.depth}
          >
            {snapshot.options.length ? (
              [...groups].map(([group, options]) => (
                <CommandCombobox.Group key={group} label={group || undefined}>
                  {options.map((option) => {
                    const Glyph = option.icon
                      ? (getEditorGlyph(option.icon) ?? FileIcon)
                      : null;
                    const help = [
                      option.description ?? option.help,
                      option.shortcut,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <Tooltip
                        key={option.id}
                        content={help}

                        side="right"
                      >
                        <CommandCombobox.Option
                          value={option.id}
                          id={listId + "-" + option.id}
                          aria-label={option.label}
                          aria-description={help || undefined}
                          data-testid={"slash-menu-item-" + option.id}
                          onMouseMove={() => {
                            store.selectOption(
                              snapshot.options.indexOf(option),
                            );
                            syncActiveDescendant();
                          }}
                        >
                          <Group>
                            {Glyph ? <Glyph /> : null}
                            {option.label}
                            {option.submenu ? <ArrowRightSmallIcon /> : null}
                          </Group>
                        </CommandCombobox.Option>
                      </Tooltip>
                    );
                  })}
                </CommandCombobox.Group>
              ))
            ) : (
              <CommandCombobox.Empty>
                {t["com.myoxus.cmdk.no-results"]()}
              </CommandCombobox.Empty>
            )}
          </CommandCombobox.Options>
        </Scrollable.Viewport>
      </CommandCombobox.Dropdown>
    </CommandCombobox>
  );
}
