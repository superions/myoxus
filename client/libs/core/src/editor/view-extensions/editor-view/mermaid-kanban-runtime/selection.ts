// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidKanbanModel,
  MermaidKanbanSelection,
} from "@virgultum/block-mermaid";
export function kanbanSelectionExists(
  model: MermaidKanbanModel,
  selection: MermaidKanbanSelection,
) {
  return selection?.cardId
    ? model.cards.some((card) => card.id === selection.cardId)
    : selection?.columnId
      ? model.columns.some((column) => column.id === selection.columnId)
      : false;
}
export function nextKanbanSelection(
  model: MermaidKanbanModel,
  id: string,
): MermaidKanbanSelection {
  const card = model.cards.find((card) => card.id === id);
  if (card) {
    const peers = model.cards.filter((item) => item.columnId === card.columnId);
    const index = peers.indexOf(card);
    const next = peers[index + 1] ?? peers[index - 1];
    return next ? { cardId: next.id } : { columnId: card.columnId };
  }
  const index = model.columns.findIndex((column) => column.id === id);
  const next = model.columns[index + 1] ?? model.columns[index - 1];
  return next ? { columnId: next.id } : undefined;
}
