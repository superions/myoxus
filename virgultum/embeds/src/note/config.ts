import type { NoteBlockModel } from "@virgultum/core/models";
import {
  type BlockStdScope,
  ConfigExtensionFactory,
} from "@virgultum/core/runtime";

type NoteBlockContext = {
  note: NoteBlockModel;
  std: BlockStdScope;
};

export type NoteConfig = {
  mountEdgelessNoteHeader: (
    anchor: HTMLElement,
    context: NoteBlockContext,
  ) => () => void;
  /** Host-owned header eligibility; absent predicates preserve Page-block headers. */
  edgelessNoteHeaderVisible?: (context: NoteBlockContext) => boolean;
  pageBlockTitleVisible?: (context: NoteBlockContext) => boolean;
  mountPageBlockTitle: (
    anchor: HTMLElement,
    context: NoteBlockContext,
  ) => () => void;
  /**
   * @returns if the viewport fit animation executed
   */
  pageBlockViewportFitAnimation?: (context: NoteBlockContext) => boolean;
};

export const NoteConfigExtension =
  ConfigExtensionFactory<NoteConfig>("myoxus:note");

export function hasEdgelessNoteHeader(context: NoteBlockContext) {
  const config = context.std.getOptional(NoteConfigExtension.identifier);
  return Boolean(
    config?.mountEdgelessNoteHeader &&
    (config.edgelessNoteHeaderVisible?.(context) ?? context.note.isPageBlock()),
  );
}
