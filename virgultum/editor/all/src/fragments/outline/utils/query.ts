import {
  NoteBlockModel,
  NoteDisplayMode,
  ParagraphBlockModel,
  RootBlockModel,
} from "@virgultum/core/models";
import {
  getOutlineHeadingBlocksFromDoc,
  getOutlineHeadingBlocksFromNote,
  getOutlineNotesFromStore,
  isOutlineHeadingBlock,
  matchModels,
} from "@virgultum/core/utils";
import type { BlockModel, Store } from "@virgultum/core/store";

export function getNotesFromStore(
  store: Store,
  modes: NoteDisplayMode[] = [
    NoteDisplayMode.DocAndEdgeless,
    NoteDisplayMode.DocOnly,
    NoteDisplayMode.EdgelessOnly,
  ],
) {
  return getOutlineNotesFromStore(store, modes);
}

export function isRootBlock(block: BlockModel): block is RootBlockModel {
  return matchModels(block, [RootBlockModel]);
}

export function isHeadingBlock(
  block: BlockModel,
): block is ParagraphBlockModel {
  return isOutlineHeadingBlock(block);
}

export function getHeadingBlocksFromNote(
  note: NoteBlockModel,
  ignoreEmpty = false,
) {
  return getOutlineHeadingBlocksFromNote(note, ignoreEmpty);
}

export function getHeadingBlocksFromDoc(
  store: Store,
  modes: NoteDisplayMode[] = [
    NoteDisplayMode.DocAndEdgeless,
    NoteDisplayMode.DocOnly,
    NoteDisplayMode.EdgelessOnly,
  ],
  ignoreEmpty = false,
) {
  return getOutlineHeadingBlocksFromDoc(store, modes, ignoreEmpty);
}
