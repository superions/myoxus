// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { PopupTarget } from "@virgultum/components/context-menu";
import {
  EditorChromeHostIdentifier,
  mountInlinePopup,
  type SelectionAction,
} from "@virgultum/shared/services";
import type { TableBlockComponent } from "./table-block";
import type { TableCell } from "./table-cell";
import { tableMenuActions, type TableMenuTarget } from "./table-menu-actions";

/** Own target identity, async command cancellation and native overlay lifetime. */
export function openTableMenu(
  cell: TableCell,
  anchor: PopupTarget,
  target: TableMenuTarget,
) {
  const table = cell.closest<TableBlockComponent>("myoxus-table");
  const chrome = table?.std.getOptional(EditorChromeHostIdentifier);
  const rowId = cell.row?.rowId,
    columnId = cell.column?.columnId;
  if (!table || !chrome || cell.readonly || !rowId || !columnId) return;
  const { std, model, store } = table;
  if (store.getBlock(model.id)?.model !== model) return;
  const manager = cell.dataManager,
    selection = cell.selectionController;
  const originalCell = manager.getCell(rowId, columnId);
  if (
    !originalCell ||
    (target.kind === "row" && target.id !== rowId) ||
    (target.kind === "column" && target.id !== columnId)
  )
    return;
  if (target.kind === "column")
    selection.setSelected({ type: "column", columnId: target.id });
  if (target.kind === "row")
    selection.setSelected({ type: "row", rowId: target.id });
  const abort = new AbortController();
  const area = "area" in target ? target.area : undefined;
  const cells = area ? manager.getCellsBySelection(area) : [];
  // Structural changes cancel an area menu rather than retarget its commands.
  const resolveArea = () => {
    if (!area) return;
    const current = manager.getCellsBySelection(area);
    if (
      cells.length &&
      current.length === cells.length &&
      current.every((cell, i) => cell === cells[i])
    )
      return area;
    return undefined;
  };
  const element =
    anchor.targetRect instanceof Element
      ? anchor.targetRect
      : anchor.targetRect.contextElement;
  const live = () =>
    !abort.signal.aborted &&
    !store.readonly &&
    table.isConnected &&
    cell.isConnected &&
    (!element || element.isConnected) &&
    cell.closest("myoxus-table") === table &&
    cell.row?.rowId === rowId &&
    cell.column?.columnId === columnId &&
    store.getBlock(model.id)?.model === model &&
    Boolean(model.props.rows[rowId] && model.props.columns[columnId]) &&
    manager.getCell(rowId, columnId) === originalCell &&
    (!area || Boolean(resolveArea()));
  const handoff = () => abort.abort("handoff");
  const protect = (action: SelectionAction): SelectionAction => ({
    ...action,
    actions: action.actions?.map(protect),
    control:
      action.control?.type === "menu"
        ? { ...action.control, items: action.control.items.map(protect) }
        : action.control,
    run: action.run
      ? async (anchor, event) => {
          if (!live() || action.disabled) return;
          try {
            await action.run!(anchor, event);
          } finally {
            abort.abort();
          }
        }
      : undefined,
  });
  if (!live()) return;
  cell.menuSession = abort.signal;
  const stopHighlight = anchor.popupStart();
  abort.signal.addEventListener("abort", stopHighlight, { once: true });
  const actions = tableMenuActions(
    cell,
    table,
    target,
    () => (live() ? resolveArea() : undefined),
    anchor,
    handoff,
  ).map(protect);
  const caret = cell.inlineEditor?.getInlineRange()?.index;
  mountInlinePopup(
    std,
    () => (live() ? anchor.targetRect : null),
    (controls) => chrome.renderTableMenu({ ...controls, actions }),
    abort,
    () => {
      if (
        abort.signal.reason === "handoff" ||
        !table.isConnected ||
        store.getBlock(model.id)?.model !== model
      )
        return;
      const cells = [...table.querySelectorAll<TableCell>("myoxus-table-cell")];
      const next =
        cells.find(
          (cell) =>
            !cell.textProtected &&
            cell.row?.rowId === rowId &&
            cell.column?.columnId === columnId,
        ) ?? cells.find((cell) => !cell.textProtected);
      if (target.kind !== "cell") selection.setSelected(undefined);
      if (next)
        next.restoreCellFocus(
          Math.min(caret ?? next.text?.length ?? 0, next.text?.length ?? 0),
        );
      else std.host.focus({ preventScroll: true });
      const current = resolveArea();
      if (target.kind === "cell" && current)
        selection.setSelected(current, false);
    },
  );
}
