// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeUrl, isValidUrl } from "@virgultum/shared/utils";
import type { KanbanColumnModel, KanbanCardModel } from "@myoxus/ui-facade";
import type { MermaidKanbanModel } from "@virgultum/block-mermaid";
import type { KanbanDraft } from "./drafts";

/** Adapt source keys to neutral IDs. Only uncommitted creation adds a local projection object. */
export function projectKanbanBoard(
  model: MermaidKanbanModel,
  readonly: boolean,
  draft?: KanbanDraft,
): KanbanColumnModel[] {
  const card = (
    item: MermaidKanbanModel["cards"][number],
  ): KanbanCardModel => ({
    id: item.id,
    columnId: item.columnId,
    label: item.label,
    open: { enabled: true },
    rename: { enabled: !readonly && item.writable },
    move: { enabled: !readonly && item.writable },
    remove: { enabled: !readonly && item.writable },
  });
  const columns: KanbanColumnModel[] = model.columns.map((column) => ({
    id: column.id,
    label: column.label,
    add: { enabled: !readonly && column.writable },
    receive: { enabled: !readonly && column.writable },
    rename: { enabled: !readonly && column.writable },
    reorder: { enabled: !readonly && column.writable },
    remove: { enabled: !readonly && column.writable },
    cards: [
      ...model.cards.filter((item) => item.columnId === column.id).map(card),
      ...(draft?.kind === "card" && draft.columnId === column.id
        ? [
            {
              id: draft.key,
              columnId: column.id,
              label: "",
              move: { enabled: false },
              remove: { enabled: false },
              open: { enabled: false },
            },
          ]
        : []),
    ],
  }));
  if (draft?.kind === "column") {
    const index = draft.afterId
      ? columns.findIndex((column) => column.id === draft.afterId) + 1
      : columns.length;
    columns.splice(index, 0, {
      id: draft.key,
      label: "",
      cards: [],
      add: { enabled: false },
      receive: { enabled: false },
      reorder: { enabled: false },
      remove: { enabled: false },
    });
  }
  return columns;
}

/** Validate the fully substituted native template through the existing shared link owner. */
export function kanbanTicketHref(template: string, ticket: string) {
  if (!template || !ticket) return null;
  const resolved = normalizeUrl(template.replace("#TICKET#", ticket));
  return resolved && isValidUrl(resolved) ? resolved : null;
}
