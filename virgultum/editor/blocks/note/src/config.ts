import type { NoteBlockModel } from "@virgultum/model";
import { type BlockStdScope, ConfigExtensionFactory } from "@virgultum/std";
import type { TemplateResult } from "lit";

type NoteBlockContext = {
  note: NoteBlockModel;
  std: BlockStdScope;
};

export type NoteConfig = {
  edgelessNoteHeader: (context: NoteBlockContext) => TemplateResult;
  /** Host-owned header eligibility; absent predicates preserve Page-block headers. */
  edgelessNoteHeaderVisible?: (context: NoteBlockContext) => boolean;
  pageBlockTitle: (context: NoteBlockContext) => TemplateResult;
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
    config?.edgelessNoteHeader &&
    (config.edgelessNoteHeaderVisible?.(context) ?? context.note.isPageBlock()),
  );
}
