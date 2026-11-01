// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type CSSProperties } from "react";
import { repeatCssLength } from "./css-utils";

export const STRUCTURE_TREE_CLASS_NAMES = {
  root: "myoxus-structure-tree-root",
  sectionContent: "myoxus-structure-tree-section__content",
  sectionHeader: "myoxus-structure-tree-section__header",
  link: "myoxus-structure-tree-link",
  row: "myoxus-structure-tree-row",
  leading: "myoxus-structure-tree-row__leading",
  main: "myoxus-structure-tree-row__main",
  label: "myoxus-structure-tree-row__label",
  actions: "myoxus-structure-tree-row__actions",
  operationButton: "myoxus-structure-tree-row__operation",
  icon: "myoxus-structure-tree-row__icon",
  renameAnchor: "myoxus-structure-tree-rename-anchor",
  content: "myoxus-structure-tree-content",
  dragPreview: "myoxus-structure-tree-drag-preview",
  dropHighlight: "myoxus-structure-tree-drop-highlight",
  dropTarget: "myoxus-structure-tree-drop-target",
  dropEffect: "myoxus-structure-tree-drop-effect",
} as const;

export const STRUCTURE_TREE_INDENT_VAR = "--myoxus-ui-structure-tree-indent";

// `useDropTarget` needs a numeric hit-zone indent. Keep that measurement at the
// Facade boundary and mirror it with the Facade-owned structure-tree variable.
export const STRUCTURE_TREE_INDENT_PER_LEVEL = 12;

// `IconAndNameEditorMenu` delegates to Mantine Popover, whose offset API is
// numeric. Keep the rename-menu measurement here so product tree code does not
// carry local pixel math or raw Popover offsets.
const STRUCTURE_TREE_RENAME_MENU_SIDE_OFFSET = 36;

const STRUCTURE_TREE_RENAME_MENU_INLINE_INSET = "var(--mantine-spacing-lg)";

export const STRUCTURE_TREE_RENAME_MENU_CONTENT_OPTIONS = {
  sideOffset: STRUCTURE_TREE_RENAME_MENU_SIDE_OFFSET,
} as const;

export function structureTreeIndentStyle(level: number): CSSProperties {
  const safeLevel = Math.max(0, Math.round(level));
  return {
    [STRUCTURE_TREE_INDENT_VAR]:
      safeLevel === 0
        ? "0"
        : repeatCssLength("var(--mantine-spacing-md)", safeLevel),
  } as CSSProperties;
}

export function structureTreeRenameMenuWidth(sidebarInlineSize: number) {
  const measuredSidebarInlineSize = Math.max(0, Math.round(sidebarInlineSize));
  return `calc(${measuredSidebarInlineSize}px - ${STRUCTURE_TREE_RENAME_MENU_INLINE_INSET})`;
}
