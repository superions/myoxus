// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/store";

export type MermaidHistoryStackItem = {
  readonly meta: ReadonlyMap<string, unknown>;
};

type Item = {
  readonly kind: "node" | "edge" | "subgraph";
  readonly editKey: string;
};
export type MermaidSelectionHistory = {
  readonly before: readonly Item[];
  readonly after: readonly Item[];
};
type Entry = MermaidSelectionHistory & { readonly ownerId: string };
const key = "mermaid-semantic-selection";

/** Semantic keys travel on the existing document entry, never a parallel stack. */
export function recordMermaidSelectionHistory(
  store: Store,
  ownerId: string,
  selection?: MermaidSelectionHistory,
) {
  if (selection)
    store.history.undoManager.undoStack
      .at(-1)
      ?.meta.set(key, { ownerId, ...selection } satisfies Entry);
}

export function readMermaidSelectionHistory(
  item?: MermaidHistoryStackItem,
): Entry | undefined {
  return item?.meta.get(key) as Entry | undefined;
}

/** Yjs creates the opposite entry during replay; retain its same semantic anchors. */
export function carryMermaidSelectionHistory(
  store: Store,
  entry: Entry,
  direction: "undo" | "redo",
) {
  const manager = store.history.undoManager;
  (direction === "undo" ? manager.redoStack : manager.undoStack)
    .at(-1)
    ?.meta.set(key, entry);
}
