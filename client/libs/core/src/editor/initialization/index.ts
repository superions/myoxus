import type { DocCreateOptions } from "@myoxus/core/modules/doc/types";
import {
  NoteDisplayMode,
  type NoteProps,
  type ParagraphProps,
  type RootBlockProps,
} from "@virgultum/editor/model";
import type { SurfaceBlockProps } from "@virgultum/editor/std/gfx";
import { type Store, Text } from "@virgultum/editor/store";

export interface DocProps {
  /** Builder content must be part of the first published content update. Its
   * onStoreLoad callback must read live Yjs: model observers have not run yet.
   * Other callers retain model-observable sequential initialization by default. */
  atomic?: boolean;
  page?: Partial<RootBlockProps>;
  surface?: Partial<SurfaceBlockProps>;
  note?: Partial<NoteProps>;
  paragraph?: Partial<ParagraphProps>;
  onStoreLoad?: (
    doc: Store,
    props: {
      noteId: string;
      paragraphId: string;
      surfaceId: string;
    },
  ) => void;
}

export function initDocFromProps(
  doc: Store,
  props?: DocProps,
  options: DocCreateOptions = {},
) {
  doc.load(() => {
    const initialize = () => {
      const pageBlockId = doc.addBlock(
        "myoxus:page",
        props?.page || { title: new Text(options.title || "") },
      );
      const surfaceId = doc.addBlock(
        "myoxus:surface" as never,
        props?.surface || {},
        pageBlockId,
      );
      const noteBlockId = doc.addBlock(
        "myoxus:note",
        {
          ...props?.note,
          displayMode: NoteDisplayMode.DocAndEdgeless,
        },
        pageBlockId,
      );
      const paragraphBlockId = doc.addBlock(
        "myoxus:paragraph",
        props?.paragraph || {},
        noteBlockId,
      );
      props?.onStoreLoad?.(doc, {
        noteId: noteBlockId,
        paragraphId: paragraphBlockId,
        surfaceId,
      });
    };
    // Store.transact catches callback failures. Propagate builder failures to
    // provisioning instead of acknowledging a partially initialized document.
    if (props?.atomic) doc.spaceDoc.transact(initialize, doc.spaceDoc.clientID);
    else initialize();
    doc.history.undoManager.clear();
  });
}
