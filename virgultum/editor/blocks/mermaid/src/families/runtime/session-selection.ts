// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockModel } from "@virgultum/model";
import type { Store } from "@virgultum/store";
import type { GfxController } from "@virgultum/std/gfx";
import type { MermaidPageSelectionItem } from "../../mermaid-page-selection-controller.js";
import { readMermaidGfxMeta } from "../../mermaid-gfx-metadata.js";
import { getMermaidGfxFamilyHooksForDiagramType } from "./gfx-family-hooks-registry.js";
import {
  readMermaidSessionState,
  writeMermaidSessionState,
} from "./session-state.js";

type Item = Pick<MermaidPageSelectionItem, "kind" | "editKey">;
type Bookmark = { ownerId: string; items: readonly Item[] };
const key = "selection-bookmark";

/** A document-scoped bookmark only: Page/native selectors still own live
 * selection and history. Record edit keys are validated against the live owner
 * after readiness, never treated as authoritative document membership. */
export function readMermaidSelectionBookmark(
  storeId: string,
): Bookmark | undefined {
  const value = readMermaidSessionState(storeId, "", key) as
    Partial<Bookmark> | undefined;
  return value &&
    typeof value.ownerId === "string" &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        item &&
        ["edge", "node", "subgraph"].includes(item.kind) &&
        typeof item.editKey === "string" &&
        item.editKey,
    )
    ? (value as Bookmark)
    : undefined;
}
export function rememberMermaidSelection(
  storeId: string,
  ownerId: string,
  diagramType: string | null,
  selection: readonly Item[],
) {
  if (!diagramType) return;
  const kinds =
    getMermaidGfxFamilyHooksForDiagramType(diagramType)?.sessionSelectionKinds;
  if (!kinds) return;
  const items = selection.filter((item) => kinds.includes(item.kind));
  if (items.length)
    writeMermaidSessionState(storeId, "", key, { ownerId, items });
  else if (readMermaidSelectionBookmark(storeId)?.ownerId === ownerId)
    writeMermaidSessionState(storeId, "", key, undefined);
}

export function pruneMermaidSelectionBookmark(
  storeId: string,
  ownerId: string,
  diagramType: string | null,
  known: (item: Item) => boolean,
) {
  const bookmark = readMermaidSelectionBookmark(storeId);
  if (bookmark?.ownerId !== ownerId) return;
  const items = bookmark.items.filter(known);
  if (items.length !== bookmark.items.length)
    rememberMermaidSelection(storeId, ownerId, diagramType, items);
}

export function bindNativeMermaidSessionSelection(
  store: Store,
  owner: MermaidBlockModel,
  gfx: GfxController,
) {
  const kinds = owner.props.diagramType
    ? getMermaidGfxFamilyHooksForDiagramType(owner.props.diagramType)
        ?.sessionSelectionKinds
    : undefined;
  if (!kinds) return { restore: () => {}, dispose: () => {} };
  let restored = false;
  const item = (element: unknown): Item | undefined => {
    for (const [kind, metadata] of [
      ["edge", "mermaidEdgeId"],
      ["node", "mermaidNodeId"],
      ["subgraph", "mermaidSubgraphId"],
    ] as const) {
      const editKey = readMermaidGfxMeta(element, metadata);
      if (editKey && kinds.includes(kind)) return { kind, editKey };
    }
    return undefined;
  };
  const restore = () => {
    if (restored) return;
    const bookmark = readMermaidSelectionBookmark(store.id);
    restored = true;
    if (bookmark?.ownerId !== owner.id || gfx.selection.selectedIds.length)
      return;
    const elements = bookmark.items.flatMap((selected) => {
      const element = owner.descendantElements.find((element) => {
        const candidate = item(element);
        return (
          candidate?.kind === selected.kind &&
          candidate.editKey === selected.editKey
        );
      });
      return element ? [element.id] : [];
    });
    if (elements.length === bookmark.items.length)
      gfx.selection.set({ editing: false, elements });
    else
      rememberMermaidSelection(store.id, owner.id, owner.props.diagramType, []);
  };
  const subscription = gfx.selection.slots.updated.subscribe(() => {
    if (!restored) return;
    rememberMermaidSelection(
      store.id,
      owner.id,
      owner.props.diagramType,
      gfx.selection.selectedElements
        .filter((element) => owner.childIds.includes(element.id))
        .flatMap((element) => {
          const selected = item(element);
          return selected ? [selected] : [];
        }),
    );
  });
  return { restore, dispose: () => subscription.unsubscribe() };
}
