// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { MoreVerticalIcon } from "@myoxus/icons/react";
import {
  Group,
  IconButton,
  IconButtonGroup,
  Menu,
  Select,
  Tooltip,
} from "@myoxus/ui-facade";
import type { EditorCodeToolbarControls } from "@virgultum/editor/shared/services";
import { useSyncExternalStore } from "react";
import { SelectionActions } from "./selection-toolbar/block-actions";
import { renderControl } from "./selection-toolbar";

export function EditorCodeToolbar({
  controls,
}: {
  controls: EditorCodeToolbarControls;
}) {
  const state = useSyncExternalStore(
    controls.subscribe,
    controls.getSnapshot,
    controls.getSnapshot,
  );
  const t = useI18n();
  const label = t["com.myoxus.editor.code.search-language"]();
  return (
    <Group
      role="toolbar"
      aria-label={t["com.myoxus.editor.keyboard.code"]()}
      data-testid="code-toolbar"
      justify="space-between"
      wrap="nowrap"
      px="xs"
      data-range-sync-exclude="true"
      contentEditable={false}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!(event.target instanceof Element && event.target.closest("input")))
          event.preventDefault();
      }}
    >
      <Tooltip content={label}>
        <Select
          data-testid="lang-button"
          aria-label={label}
          searchable
          contentSized
          size="xs"
          variant="unstyled"
          allowDeselect={false}
          selectFirstOptionOnChange
          data={[...state.languages]}
          value={state.language}
          placeholder={state.languageName}
          disabled={state.readonly}
          nothingFoundMessage={t["com.myoxus.cmdk.no-results"]()}
          onChange={controls.chooseLanguage}
          onFocus={(event) => event.currentTarget.select()}
          filter={({ options, search }) =>
            options.filter(
              (option) =>
                "value" in option &&
                [
                  option.label,
                  option.value,
                  ...(state.languages.find(
                    (lang) => lang.value === option.value,
                  )?.aliases ?? []),
                ].some((name) =>
                  name
                    .toLocaleLowerCase()
                    .startsWith(search.trim().toLocaleLowerCase()),
                ),
            )
          }
          onDropdownOpen={() => controls.setActive(true)}
          onDropdownClose={() => controls.setActive(false)}
          comboboxProps={{
            withinPortal: false,
            // Editor pointer handlers consume compatibility mouse events.
            clickOutsideEvents: ["click"],
          }}
        />
      </Tooltip>
      <IconButtonGroup>
        <SelectionActions
          actions={state.primary}
          renderControl={renderControl}
        />
        <Menu
          noPortal
          rootOptions={{
            onOpen: () => controls.setActive(true),
            onClose: () => controls.setActive(false),
            clickOutsideEvents: ["click"],
          }}
          items={
            <SelectionActions
              actions={state.more}
              menu
              renderControl={renderControl}
            />
          }
        >
          <IconButton
            disabled={state.readonly}
            aria-label={t["com.myoxus.editor.toolbar.more"]()}
            tooltip={t["com.myoxus.editor.toolbar.more"]()}
            icon={<MoreVerticalIcon />}
          />
        </Menu>
      </IconButtonGroup>
    </Group>
  );
}
