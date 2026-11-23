// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { type ReactNode, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { toReactNode } from "@myoxus/lit-react";
import {
  Box,
  Center,
  Group,
  Divider,
  ToolbarSurface,
  IconButton,
  MenuTrigger,
  Menu,
  type MenuRef,
  MenuSearch,
  EmptyState,
} from "@myoxus/ui-facade";
import type {
  EditorCanvasToolbarControls,
  EditorCanvasToolbarItem,
  EditorCanvasToolControls,
} from "@virgultum/editor/shared/services";
import {
  ActionButton,
  SelectionActions,
  preserveEditorCommandFocus,
} from "./selection-toolbar/block-actions";
import { renderControl } from "./selection-toolbar";
import { editorGlyph } from "./glyphs";

export function EditorCanvasTool({
  action,
  menu,
  artwork,
  nativeArtwork,
  artworkBounds,
  artworkColor,
  expanded,
}: EditorCanvasToolControls) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<EditorCanvasToolControls["action"][]>(
    [],
  );
  const t = useI18n();
  const search = (value: string) => {
    setQuery(value);
    setActions(menu?.actions(value) ?? []);
  };
  const isExpanded = menu ? opened : expanded;
  const hasArtwork = Boolean(nativeArtwork ?? artwork);
  const Control =
    !hasArtwork && isExpanded !== undefined ? MenuTrigger : IconButton;
  const trigger = (
    <Control
      data-testid={action.id}
      size={artworkBounds?.height}
      style={artworkBounds ? { width: artworkBounds.width } : undefined}
      tooltip={isExpanded ? undefined : action.label}
      tooltipShortcut={action.shortcut ? [action.shortcut] : undefined}
      aria-label={action.label}
      aria-pressed={action.active}
      aria-expanded={isExpanded}
      disabled={action.disabled}
      variant={action.active ? "secondary" : "plain"}
      onPointerDown={preserveEditorCommandFocus}
      onClick={(event) => action.run?.(event.currentTarget, event.nativeEvent)}
    >
      {hasArtwork ? (
        <Box component="span" style={{ color: artworkColor }}>
          {(nativeArtwork as ReactNode) ?? toReactNode(artwork)}
        </Box>
      ) : (
        editorGlyph(action.icon)
      )}
    </Control>
  );
  return menu ? (
    <Menu
      title={action.label}
      rootOptions={{
        onOpen: () => {
          menu.onOpen?.();
          setOpened(true);
          search("");
        },
        onClose: () => setOpened(false),
      }}
      contentOptions={{ side: "top", align: "start" }}
      items={
        <>
          <MenuSearch
            value={query}
            onChange={(event) => search(event.currentTarget.value)}
            aria-label={menu.searchPlaceholder}
            placeholder={menu.searchPlaceholder}
            onCopy={(event) => event.stopPropagation()}
            onCut={(event) => event.stopPropagation()}
            onPaste={(event) => event.stopPropagation()}
          />
          {actions.length ? (
            <SelectionActions
              actions={actions}
              menu
              renderControl={renderControl}
            />
          ) : (
            <EmptyState title={t["com.myoxus.cmdk.no-results"]()} />
          )}
        </>
      }
    >
      {trigger}
    </Menu>
  ) : (
    trigger
  );
}

function renderToolbarItem(item: EditorCanvasToolbarItem) {
  return "controls" in item ? (
    <EditorCanvasTool {...item.controls} />
  ) : (
    toReactNode(item)
  );
}

export function EditorCanvasToolbar({
  controls,
}: {
  controls: EditorCanvasToolbarControls;
}) {
  const moreMenu = useRef<MenuRef>(null);
  // Tool poppers and retained artwork extend beyond the canvas dock bounds.
  return (
    <ToolbarSurface
      compact
      justify="center"
      role="toolbar"
      style={{ overflow: "visible" }}
    >
      <Group
        ref={controls.setContainer}
        className="edgeless-toolbar-container"
        wrap="nowrap"
        gap="xs"
      >
        {controls.presentation ? (
          toReactNode(controls.presentation)
        ) : (
          <>
            <Group wrap="nowrap" gap="xs">
              {controls.quick.map((content, index) => (
                <Box key={index}>{renderToolbarItem(content)}</Box>
              ))}
            </Group>
            {controls.more && (
              <Menu
                ref={moreMenu}
                noPortal
                items={
                  <SelectionActions
                    actions={controls.more.control.items}
                    menu
                    afterAction={() => moreMenu.current?.changeOpen(false)}
                    renderControl={renderControl}
                  />
                }
              >
                <ActionButton action={controls.more} />
              </Menu>
            )}
            <Divider orientation="vertical" />
            {controls.navigation[0] && (
              <ActionButton action={controls.navigation[0]} />
            )}
            <Group wrap="nowrap" gap={0}>
              {controls.senior.map((content, index) => (
                // Existing artwork and drag hit boxes retain their canvas geometry.
                <Center key={index} w={96} h={64}>
                  {renderToolbarItem(content)}
                </Center>
              ))}
            </Group>
            {controls.navigation[1] && (
              <ActionButton action={controls.navigation[1]} />
            )}
          </>
        )}
      </Group>
    </ToolbarSurface>
  );
}
