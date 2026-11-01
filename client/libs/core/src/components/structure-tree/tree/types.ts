/**
 * Describes a single action entry that can appear on a structure-tree tree
 * node (either as an inline icon button or in the `...` context-menu).
 *
 * - `index`  — sort key; lower values appear first.
 * - `view`   — the rendered UI element, typically a Facade tree action or menu item.
 * - `inline` — when `true` the operation is rendered inline next to the node
 *              label; when `false` or absent it appears only in the context menu.
 * - `alwaysVisible` — keeps an inline primary destination visible without
 *                     hover, including compact pointer-capable layouts.
 */
export type NodeOperation = {
  index: number;
  view: React.ReactNode;
  inline?: boolean;
  alwaysVisible?: boolean;
};
