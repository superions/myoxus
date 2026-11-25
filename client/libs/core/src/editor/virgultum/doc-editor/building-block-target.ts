// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockSelection,
  TextSelection,
  type BlockStdScope,
} from "@virgultum/core/runtime";
import type { BlockModel, Store } from "@virgultum/core/store";
import {
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
  type RelativePosition,
} from "yjs";

export class BuildingBlockTargetError extends Error {
  constructor(
    readonly reason: "readonly" | "table-cell" | "no-body" | "stale-target",
  ) {
    super(reason);
  }
}

export interface BuildingBlockTarget {
  readonly store?: Store;
  readonly std?: BlockStdScope;
  readonly workspaceId: string;
  readonly docId: string;
  readonly noteId: string;
  readonly blockId: string;
  readonly afterSelection: boolean;
  readonly caret: RelativePosition | null;
  readonly selection: (TextSelection | BlockSelection)[];
  readonly isConnected?: () => boolean;
  readonly restoreFocus?: (blockId: string, caret: number | null) => void;
}

export function buildingBlockTargetStore(target: BuildingBlockTarget): Store {
  const store = target.store ?? target.std?.store;
  if (!store) throw new BuildingBlockTargetError("stale-target");
  return store;
}

function bodyChild(store: Store, id: string) {
  let block = store.getModelById(id);
  let parent = block && store.getParent(block);
  while (block && parent && parent.flavour !== "myoxus:note") {
    if (block.flavour === "myoxus:table" || parent.flavour === "myoxus:table")
      throw new BuildingBlockTargetError("table-cell");
    block = parent;
    parent = store.getParent(block);
  }
  if (!block || !parent) throw new BuildingBlockTargetError("no-body");
  return { block, note: parent };
}

/** Freeze a Page-mode body destination directly on Store without BlockStdScope. */
export function capturePageBuildingBlockTarget(
  store: Store,
  blockId: string,
  caretOffset: number | null,
  root: HTMLElement,
  restoreFocus?: (blockId: string, caret: number | null) => void,
): BuildingBlockTarget {
  if (store.readonly) throw new BuildingBlockTargetError("readonly");
  const { block, note } = bodyChild(store, blockId);
  return {
    store,
    workspaceId: store.workspace.id,
    docId: store.id,
    noteId: note.id,
    blockId: block.id,
    afterSelection: caretOffset === null,
    caret:
      caretOffset !== null && block.id === blockId && block.text
        ? createRelativePositionFromTypeIndex(
            block.text.yText,
            Math.min(block.text.length, Math.max(0, caretOffset)),
          )
        : null,
    selection: [],
    isConnected: () => root.isConnected,
    restoreFocus,
  };
}

/** Freeze the body destination before the picker takes focus. A Yjs position
 * follows edits inside the original paragraph without guessing a new block.
 */
export function captureBuildingBlockTarget(
  std: BlockStdScope,
): BuildingBlockTarget {
  if (std.store.readonly) throw new BuildingBlockTargetError("readonly");
  if (std.selection.value.some((selection) => selection.type === "table"))
    throw new BuildingBlockTargetError("table-cell");
  const text = std.selection.find(TextSelection);
  const blocks = std.selection.filter(BlockSelection);
  const ids = text
    ? [text.from.blockId, ...(text.to ? [text.to.blockId] : [])]
    : blocks.map((selection) => selection.blockId);
  if (!ids.length) throw new BuildingBlockTargetError("no-body");
  const children = ids.map((id) => bodyChild(std.store, id));
  const note = children[0].note;
  if (children.some((child) => child.note.id !== note.id))
    throw new BuildingBlockTargetError("no-body");
  const block = children.reduce((last, child) =>
    note.children.indexOf(child.block) > note.children.indexOf(last.block)
      ? child
      : last,
  ).block;
  const collapsed = text?.isCollapsed() ?? false;
  return {
    store: std.store,
    std,
    workspaceId: std.store.workspace.id,
    docId: std.store.id,
    noteId: note.id,
    blockId: block.id,
    afterSelection: !collapsed,
    caret:
      collapsed && block.id === text!.from.blockId && block.text
        ? createRelativePositionFromTypeIndex(
            block.text.yText,
            text!.from.index,
          )
        : null,
    selection: text
      ? [TextSelection.fromJSON(text.toJSON())]
      : blocks.map((selection) => BlockSelection.fromJSON(selection.toJSON())),
  };
}

/** Revalidate against the captured host and Note, never the currently focused
 * editor or the end of a document whose original anchor has disappeared.
 */
export function resolveBuildingBlockTarget(target: BuildingBlockTarget): {
  block: BlockModel;
  note: BlockModel;
  index: number;
  caret: number | null;
} {
  const store = buildingBlockTargetStore(target);
  const { std } = target;
  const connected = target.isConnected
    ? target.isConnected()
    : (std?.host.isConnected ?? false);
  if (
    !connected ||
    store.id !== target.docId ||
    store.workspace.id !== target.workspaceId
  )
    throw new BuildingBlockTargetError("stale-target");
  if (store.readonly) throw new BuildingBlockTargetError("readonly");
  const block = store.getModelById(target.blockId);
  const note = store.getModelById(target.noteId);
  if (!block || !note || store.getParent(block)?.id !== note.id)
    throw new BuildingBlockTargetError("stale-target");
  const index = note.children.indexOf(block);
  const position =
    target.caret &&
    createAbsolutePositionFromRelativePosition(target.caret, store.spaceDoc);
  if (
    index < 0 ||
    (target.caret && (!position || position.type !== block.text?.yText))
  )
    throw new BuildingBlockTargetError("stale-target");
  return { block, note, index, caret: position ? position.index : null };
}

export function restoreBuildingBlockTarget(target: BuildingBlockTarget) {
  const { caret, block } = resolveBuildingBlockTarget(target);
  if (!target.std) {
    target.restoreFocus?.(block.id, caret);
    return;
  }
  const selection =
    caret === null
      ? target.selection
      : [
          new TextSelection({
            from: { blockId: block.id, index: caret, length: 0 },
            to: null,
          }),
        ];
  target.std.host.focus({ preventScroll: true });
  target.std.selection.setGroup("note", selection);
  const text = selection.find((value) => value instanceof TextSelection);
  if (text instanceof TextSelection)
    target.std.range.syncTextSelectionToRange(text);
}
