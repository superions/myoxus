// SPDX-License-Identifier: AGPL-3.0-or-later

import type { KanbanCommand } from "@virgultum/block-mermaid";
let draftKey = 0;
export type KanbanDraft = {
  key: string;
  kind: "column" | "card";
  columnId?: string;
  afterId?: string;
  source: string;
};
export function createKanbanDraft(
  kind: KanbanDraft["kind"],
  source: string,
  columnId?: string,
  afterId?: string,
): KanbanDraft {
  return { key: `kanban-draft-${++draftKey}`, kind, source, columnId, afterId };
}
export function kanbanDraftCommand(
  draft: KanbanDraft,
  label: string,
): KanbanCommand {
  return {
    type: "add",
    kind: draft.kind,
    label,
    columnId: draft.columnId,
    afterId: draft.afterId,
  };
}
