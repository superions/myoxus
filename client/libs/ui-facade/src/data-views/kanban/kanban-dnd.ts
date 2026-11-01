// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DNDData } from "../../dnd/types";
import type {
  KanbanColumnModel,
  KanbanCardMove,
  KanbanColumnMove,
} from "./types";
export function wouldMoveKanbanCard(
  columns: ReadonlyArray<KanbanColumnModel>,
  move: KanbanCardMove,
  order: "manual" | "external" = "manual",
) {
  const sourceColumn = columns.find(
    (column) => column.id === move.fromColumnId,
  );
  const targetColumn = columns.find((column) => column.id === move.toColumnId);
  if (
    !sourceColumn?.cards.some((card) => card.id === move.cardId) ||
    !targetColumn ||
    targetColumn.receive?.enabled === false ||
    sourceColumn.cards.find((card) => card.id === move.cardId)?.move
      ?.enabled === false
  ) {
    return false;
  }
  if (order === "external") return sourceColumn.id !== targetColumn.id;
  const targetCards = targetColumn.cards.filter(
    (card) => card.id !== move.cardId,
  );
  if (
    move.targetCardId &&
    !targetCards.some(
      (card) => card.id === move.targetCardId && card.move?.enabled !== false,
    )
  ) {
    return false;
  }
  if (sourceColumn.id !== targetColumn.id) return true;
  const before = sourceColumn.cards.map((card) => card.id);
  const after = targetCards.map((card) => card.id);
  const targetIndex = move.targetCardId ? after.indexOf(move.targetCardId) : -1;
  after.splice(
    targetIndex < 0
      ? after.length
      : targetIndex + (move.edge === "after" ? 1 : 0),
    0,
    move.cardId,
  );
  return before.some((id, index) => id !== after[index]);
}

export function wouldMoveKanbanColumn(
  columns: ReadonlyArray<KanbanColumnModel>,
  move: KanbanColumnMove,
) {
  const before = columns.map((column) => column.id);
  if (
    move.columnId === move.targetColumnId ||
    !before.includes(move.columnId) ||
    !before.includes(move.targetColumnId) ||
    columns.some(
      (column) =>
        [move.columnId, move.targetColumnId].includes(column.id) &&
        column.reorder?.enabled === false,
    )
  ) {
    return false;
  }
  const after = before.filter((id) => id !== move.columnId);
  const targetIndex = after.indexOf(move.targetColumnId);
  after.splice(targetIndex + (move.edge === "after" ? 1 : 0), 0, move.columnId);
  return before.some((id, index) => id !== after[index]);
}

export type KanbanDndData = DNDData<
  | {
      type: "kanban-card";
      boardId: string;
      cardId: string;
      columnId: string;
    }
  | { type: "kanban-column"; boardId: string; columnId: string },
  | {
      type: "kanban-card";
      boardId: string;
      cardId: string;
      columnId: string;
    }
  | { type: "kanban-column"; boardId: string; columnId: string }
>;

export type KanbanKeyboardCardDrag = {
  readonly cardId: string;
  readonly columnIndex: number;
  readonly insertionIndex: number;
};

export type KanbanKeyboardColumnDrag = {
  readonly columnId: string;
  readonly targetIndex: number;
};

export function isKanbanActionTarget(target: EventTarget) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, [contenteditable='true'], [data-myoxus-kanban-interaction], [data-myoxus-ui-role='inline-edit-input']",
    ),
  );
}
