// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  CodeIcon,
  CopyIcon,
  DoneIcon,
  MoreVerticalIcon,
} from "@myoxus/icons/react";
import {
  Box,
  Button,
  Divider,
  Group,
  IconButton,
  Menu,
  MenuSectionLabel,
  Select,
  ViewSwitcher,
} from "@myoxus/ui-facade";
import { installEditorStyles } from "@virgultum/core/runtime";
import type {
  EditorCodeToolbarControls,
  SelectionAction,
} from "@virgultum/editor/shared/services";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { editorGlyph } from "./glyphs";
import { renderControl } from "./selection-toolbar";
import {
  preserveEditorCommandFocus,
  SelectionActions,
} from "./selection-toolbar/block-actions";

const CODE_HEADER_STYLES = `
[data-myoxus-ui-role="code-block-header"] {
  font-family: var(--mantine-font-family);
  font-size: var(--mantine-font-size-xs);
  line-height: var(--mantine-line-height-xs);
  height: 36px;
  min-height: 36px;
  padding: 0 8px 0 10px;
  background: var(--myoxus-background-secondary-color);
  border-bottom: 1px solid var(--myoxus-border-color);
  border-start-start-radius: calc(var(--mantine-radius-lg) - 1px);
  border-start-end-radius: calc(var(--mantine-radius-lg) - 1px);
  box-sizing: border-box;
}

[data-myoxus-ui-role="code-block-header"][data-floating="true"] {
  background: var(--myoxus-background-overlay-panel-color);
  border: 1px solid var(--myoxus-border-color);
  border-radius: var(--mantine-radius-md);
  box-shadow: var(--mantine-shadow-md);
  padding: 0 8px;
}

[data-myoxus-ui-role="code-block-header"] [data-code-lang-select="true"] {
  border-radius: var(--mantine-radius-sm);
  color: var(--myoxus-text-secondary-color);
  transition: background-color 120ms ease, color 120ms ease;
}

[data-myoxus-ui-role="code-block-header"]
  [data-code-lang-select="true"]:not([data-readonly="true"]):is(
    :hover,
    :focus-within
  ) {
  background: color-mix(in srgb, var(--myoxus-text-primary-color) 7%, transparent);
  color: var(--myoxus-text-primary-color);
}

[data-myoxus-ui-role="code-block-header"]
  [data-code-lang-select="true"]:not([data-readonly="true"]):is(
    :hover,
    :focus-within
  )
  .mantine-Select-section {
  color: var(--myoxus-icon-color);
}

[data-myoxus-ui-role="code-block-header"]
  [data-testid="code-preview-toggle"] {
  background: var(--myoxus-background-code-block);
  border: 1px solid var(--myoxus-border-color);
  padding: 2px;
}

[data-myoxus-ui-role="code-block-header"]
  [data-testid="code-preview-toggle"]
  .mantine-SegmentedControl-indicator {
  background: var(--myoxus-background-primary-color);
  box-shadow: var(--mantine-shadow-xs);
}

[data-myoxus-ui-role="code-block-header"] [data-code-copy-button="true"]:hover {
  background: color-mix(in srgb, var(--myoxus-text-primary-color) 7%, transparent) !important;
  color: var(--myoxus-text-primary-color) !important;
}

[data-myoxus-ui-role="code-block-header"]
  [data-code-copy-button="true"][data-copied="true"] {
  color: var(--myoxus-success-color) !important;
}

[data-myoxus-ui-role="code-block-header"] [data-code-secondary-actions="true"] {
  opacity: 0.78;
  transition: opacity 140ms ease;
}

[data-page-code]:is(:hover, :focus-within, [data-toolbar-active="true"])
  [data-myoxus-ui-role="code-block-header"]
  [data-code-secondary-actions="true"],
[data-myoxus-ui-role="code-block-header"][data-floating="true"]
  [data-code-secondary-actions="true"],
[data-myoxus-ui-role="code-block-header"]:is(:hover, :focus-within)
  [data-code-secondary-actions="true"] {
  opacity: 1;
}
`;

function installCodeHeaderStyles(node: HTMLElement | null) {
  if (node) installEditorStyles(node, CODE_HEADER_STYLES);
}

function CodeHeaderCopyButton({ action }: { action: SelectionAction }) {
  const t = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <Button
      data-testid={action.id}
      data-code-copy-button="true"
      data-copied={copied ? "true" : undefined}
      variant="plain"
      aria-label={copied ? t["Copied to clipboard"]() : action.label}
      tooltip={copied ? t["Copied to clipboard"]() : action.label}
      disabled={action.disabled}
      prefix={
        copied ? (
          <DoneIcon width={15} height={15} />
        ) : (
          <CopyIcon width={15} height={15} />
        )
      }
      style={{
        height: "28px",
        minHeight: "28px",
        paddingInline: "8px",
        fontSize: "var(--mantine-font-size-xs)",
        fontWeight: 500,
        color: copied
          ? "var(--myoxus-success-color)"
          : "var(--myoxus-text-secondary-color)",
      }}
      onPointerDown={preserveEditorCommandFocus}
      onClick={(event) => {
        action.run?.(event.currentTarget, event.nativeEvent);
        if (timerRef.current) clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 2000);
      }}
    >
      {t.Copy()}
    </Button>
  );
}

function CodeHeaderAction({ action }: { action: SelectionAction }) {
  const icon = editorGlyph(action.icon);
  const control = action.control;
  if (control?.type === "menu") {
    return (
      <Menu
        noPortal
        rootOptions={{
          onOpen: control.onOpen,
          onClose: () => queueMicrotask(() => control.onClose?.()),
          returnFocus: !control.onClose,
          clickOutsideEvents: ["click"],
        }}
        items={
          <>
            <MenuSectionLabel>{action.label}</MenuSectionLabel>
            <SelectionActions
              actions={control.items}
              menu
              renderControl={renderControl}
            />
          </>
        }
      >
        <IconButton
          data-testid={action.id}
          aria-label={action.label}
          tooltip={action.label}
          disabled={action.disabled}
          aria-pressed={action.active}
          variant={action.active ? "secondary" : "plain"}
          icon={icon}
          onPointerDown={preserveEditorCommandFocus}
        />
      </Menu>
    );
  }
  return <SelectionActions actions={[action]} renderControl={renderControl} />;
}

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
  const previewAction = state.primary.find((item) => item.id === "preview");
  const copyAction = state.primary.find((item) => item.id === "copy-code");
  const otherPrimary = state.primary.filter(
    (item) => item.id !== "preview" && item.id !== "copy-code",
  );

  return (
    <Group
      ref={installCodeHeaderStyles}
      role="toolbar"
      aria-label={t["com.myoxus.editor.keyboard.code"]()}
      data-testid="code-toolbar"
      data-myoxus-ui-role="code-block-header"
      data-floating={state.floating ? "true" : undefined}
      justify="space-between"
      align="center"
      gap="sm"
      wrap="nowrap"
      data-range-sync-exclude="true"
      contentEditable={false}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!(
          event.target instanceof Element && event.target.closest("input,label")
        ))
          event.preventDefault();
      }}
    >
      <Group gap="sm" align="center" wrap="nowrap" miw={0}>
        <Box
          data-code-lang-select="true"
          data-readonly={state.readonly ? "true" : undefined}
        >
          <Select
            data-testid="lang-button"
            aria-label={label}
            searchable
            contentSized
            size="xs"
            variant="unstyled"
            allowDeselect={false}
            selectFirstOptionOnChange
            leftSection={<CodeIcon width={14} height={14} />}
            leftSectionPointerEvents="none"
            leftSectionWidth={26}
            rightSection={
              state.readonly ? null : (
                <ArrowDownSmallIcon width={14} height={14} />
              )
            }
            rightSectionPointerEvents="none"
            rightSectionWidth={state.readonly ? 0 : 22}
            styles={{
              input: {
                height: "28px",
                minHeight: "28px",
                minWidth: "72px",
                paddingInlineStart: "26px",
                paddingInlineEnd: state.readonly ? "8px" : "22px",
                fontSize: "var(--mantine-font-size-xs)",
                lineHeight: "28px",
                fontWeight: 500,
                background: "transparent",
                border: 0,
                color: "inherit",
                caretColor: "var(--myoxus-primary-color)",
                cursor: state.readonly ? "default" : "pointer",
                opacity: 1,
              },
              section: {
                color: "var(--myoxus-icon-secondary)",
              },
            }}
            data={[...state.languages]}
            value={state.language}
            placeholder={state.languageName}
            disabled={state.readonly}
            nothingFoundMessage={t["com.myoxus.cmdk.no-results"]()}
            onChange={controls.chooseLanguage}
            onFocus={(event) => event.currentTarget.select()}
            filter={({ options, search }) => {
              const query = search.trim().toLocaleLowerCase();
              if (!query) return options;
              const matchRank = (option: (typeof options)[number]) => {
                if (!("value" in option)) return -1;
                const names = [
                  option.label,
                  option.value,
                  ...(state.languages.find(
                    (lang) => lang.value === option.value,
                  )?.aliases ?? []),
                ].map((name) => name.toLocaleLowerCase());
                if (names.some((name) => name.startsWith(query))) return 2;
                if (names.some((name) => name.includes(query))) return 1;
                return 0;
              };
              return options
                .filter((option) => matchRank(option) > 0)
                .sort((a, b) => matchRank(b) - matchRank(a));
            }}
            onDropdownOpen={() => controls.setActive(true)}
            onDropdownClose={() => controls.setActive(false)}
            comboboxProps={{
              withinPortal: false,
              position: "bottom-start",
              width: 220,
              offset: 6,
              // Editor pointer handlers consume compatibility mouse events.
              clickOutsideEvents: ["click"],
            }}
          />
        </Box>
        {previewAction ? (
          <ViewSwitcher
            size="xs"
            aria-label={previewAction.label}
            data-testid="code-preview-toggle"
            value={previewAction.active ? "preview" : "code"}
            items={[
              {
                value: "code",
                label: t["com.myoxus.editor.keyboard.code"](),
              },
              {
                value: "preview",
                label: previewAction.label,
              },
            ]}
            onChange={(next) => {
              if ((next === "preview") !== !!previewAction.active) {
                previewAction.run?.(
                  document.activeElement as HTMLElement,
                  new MouseEvent("click"),
                );
              }
            }}
          />
        ) : null}
      </Group>

      <Group gap="2xs" align="center" wrap="nowrap">
        {copyAction ? <CodeHeaderCopyButton action={copyAction} /> : null}
        <Group
          gap="2xs"
          align="center"
          wrap="nowrap"
          data-code-secondary-actions="true"
        >
          {otherPrimary.map((action) => (
            <CodeHeaderAction key={action.id} action={action} />
          ))}
          {copyAction || otherPrimary.length > 0 ? (
            <Divider
              orientation="vertical"
              style={{ height: "16px", alignSelf: "center" }}
            />
          ) : null}
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
              onPointerDown={preserveEditorCommandFocus}
            />
          </Menu>
        </Group>
      </Group>
    </Group>
  );
}
