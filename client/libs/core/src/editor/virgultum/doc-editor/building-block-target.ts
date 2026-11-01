// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockSelection,
  TextSelection,
  type BlockStdScope,
} from "@virgultum/editor/std";
import type { BlockModel } from "@virgultum/editor/store";
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
  readonly std: BlockStdScope;
  readonly workspaceId: string;
  readonly docId: string;
  readonly noteId: string;
  readonly blockId: string;
  readonly afterSelection: boolean;
  readonly caret: RelativePosition | null;
  readonly selection: (TextSelection | BlockSelection)[];
}

function bodyChild(std: BlockStdScope, id: string) {
  let block = std.store.getModelById(id);
  let parent = block && std.store.getParent(block);
  while (block && parent && parent.flavour !== "myoxus:note") {
    if (block.flavour === "myoxus:table" || parent.flavour === "myoxus:table")
      throw new BuildingBlockTargetError("table-cell");
    block = parent;
    parent = std.store.getParent(block);
  }
  if (!block || !parent) throw new BuildingBlockTargetError("no-body");
  return { block, note: parent };
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
  const children = ids.map((id) => bodyChild(std, id));
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
  const { std } = target;
  if (
    !std.host.isConnected ||
    std.store.id !== target.docId ||
    std.store.workspace.id !== target.workspaceId
  )
    throw new BuildingBlockTargetError("stale-target");
  if (std.store.readonly) throw new BuildingBlockTargetError("readonly");
  const block = std.store.getModelById(target.blockId);
  const note = std.store.getModelById(target.noteId);
  if (!block || !note || std.store.getParent(block)?.id !== note.id)
    throw new BuildingBlockTargetError("stale-target");
  const index = note.children.indexOf(block);
  const position =
    target.caret &&
    createAbsolutePositionFromRelativePosition(
      target.caret,
      std.store.spaceDoc,
    );
  if (
    index < 0 ||
    (target.caret && (!position || position.type !== block.text?.yText))
  )
    throw new BuildingBlockTargetError("stale-target");
  return { block, note, index, caret: position ? position.index : null };
}

export function restoreBuildingBlockTarget(target: BuildingBlockTarget) {
  const { caret, block } = resolveBuildingBlockTarget(target);
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
