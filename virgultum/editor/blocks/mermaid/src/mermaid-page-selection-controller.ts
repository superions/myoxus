// SPDX-License-Identifier: AGPL-3.0-or-later

import { signal } from "@preact/signals-core";

export type MermaidPageSelectionItem = {
  readonly editKey: string;
  readonly gfxElementId: string;
  readonly kind: "edge" | "node" | "subgraph";
};

export type MermaidPageSelectionOperation =
  "add" | "replace" | "subtract" | "toggle";

function itemIdentity(
  item: Pick<MermaidPageSelectionItem, "editKey" | "kind">,
) {
  return `${item.kind}\u0000${item.editKey}`;
}

function uniqueItems(items: readonly MermaidPageSelectionItem[]) {
  const identities = new Set<string>();
  return items.filter((item) => {
    if (!item.editKey || !item.gfxElementId) return false;
    const identity = itemIdentity(item);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

/**
 * Non-persistent owner of Page Mermaid selection.
 *
 * Stable edit keys survive source reparses; scoped GFX ids are only the current
 * projection. Every product selection transition goes through this owner and
 * is projected to native SurfaceSelection in the same synchronous step.
 */
export class MermaidPageSelectionController {
  private readonly _items$ = signal<readonly MermaidPageSelectionItem[]>([]);

  constructor(
    private readonly writeScopedSelection: (
      items: readonly MermaidPageSelectionItem[],
    ) => void,
    /** Explicit transitions only; remapping a transient projection is not a user choice. */
    private readonly onSelectionTransition?: (
      items: readonly MermaidPageSelectionItem[],
    ) => void,
  ) {}

  get items() {
    return this._items$.value;
  }

  get anchor() {
    return this._items$.value.at(-1) ?? null;
  }

  itemsOfKind(kind: MermaidPageSelectionItem["kind"]) {
    return this._items$.value.filter((item) => item.kind === kind);
  }

  apply(
    operation: MermaidPageSelectionOperation,
    candidates: readonly MermaidPageSelectionItem[],
  ) {
    this.applyAgainst(this._items$.peek(), operation, candidates);
  }

  applyAgainst(
    baseItems: readonly MermaidPageSelectionItem[],
    operation: MermaidPageSelectionOperation,
    candidates: readonly MermaidPageSelectionItem[],
  ) {
    const base = uniqueItems(baseItems);
    const nextCandidates = uniqueItems(candidates);
    const candidateIdentities = new Set(nextCandidates.map(itemIdentity));
    let next: readonly MermaidPageSelectionItem[];
    if (operation === "replace") {
      next = nextCandidates;
    } else if (operation === "subtract") {
      next = base.filter(
        (item) => !candidateIdentities.has(itemIdentity(item)),
      );
    } else if (operation === "add") {
      const currentIdentities = new Set(base.map(itemIdentity));
      next = [
        ...base,
        ...nextCandidates.filter(
          (item) => !currentIdentities.has(itemIdentity(item)),
        ),
      ];
    } else {
      next = [...base];
      for (const candidate of nextCandidates) {
        const identity = itemIdentity(candidate);
        const index = next.findIndex((item) => itemIdentity(item) === identity);
        next =
          index < 0
            ? [...next, candidate]
            : next.filter((_, itemIndex) => itemIndex !== index);
      }
    }
    this.commit(next);
    this.onSelectionTransition?.(this._items$.peek());
  }

  clear() {
    this.commit([]);
    this.onSelectionTransition?.(this._items$.peek());
  }

  /** Accepts the complete, already scoped native selection without echoing it. */
  hydrate(items: readonly MermaidPageSelectionItem[]) {
    this._items$.value = uniqueItems(items);
  }

  /** Re-resolves projection ids after source/GFX replacement, then writes once. */
  remap(
    resolveGfxElementId: (item: MermaidPageSelectionItem) => string | null,
  ) {
    const remapped = this._items$.peek().flatMap((item) => {
      const gfxElementId = resolveGfxElementId(item);
      return gfxElementId ? [{ ...item, gfxElementId }] : [];
    });
    this.commit(remapped);
  }

  project() {
    this.writeScopedSelection(this._items$.peek());
  }

  private commit(items: readonly MermaidPageSelectionItem[]) {
    const unique = uniqueItems(items);
    this._items$.value = unique;
    this.writeScopedSelection(unique);
  }
}
