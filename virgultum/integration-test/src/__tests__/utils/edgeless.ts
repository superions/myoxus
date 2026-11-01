import type {
  EdgelessRootBlockComponent,
  PageRootBlockComponent,
} from "@virgultum/editor/blocks/root";
import type { SurfaceBlockComponent } from "@virgultum/editor/blocks/surface";
import type { Store } from "@virgultum/store";

import type { TestMyoxusEditorContainer } from "../../index.js";

export function getSurface(doc: Store, editor: TestMyoxusEditorContainer) {
  const surfaceModel = doc.getModelsByFlavour("myoxus:surface");

  return editor.host!.view.getBlock(
    surfaceModel[0]!.id,
  ) as SurfaceBlockComponent;
}

export function getDocRootBlock(
  doc: Store,
  editor: TestMyoxusEditorContainer,
  mode: "page",
): PageRootBlockComponent;
export function getDocRootBlock(
  doc: Store,
  editor: TestMyoxusEditorContainer,
  mode: "edgeless",
): EdgelessRootBlockComponent;
export function getDocRootBlock(
  doc: Store,
  editor: TestMyoxusEditorContainer,
  _?: "edgeless" | "page",
) {
  return editor.host!.view.getBlock(doc.root!.id) as
    EdgelessRootBlockComponent | PageRootBlockComponent;
}

export function addNote(doc: Store, props: Record<string, any> = {}) {
  const noteId = doc.addBlock(
    "myoxus:note",
    {
      xywh: "[0, 0, 800, 100]",
      ...props,
    },
    doc.root,
  );

  doc.addBlock("myoxus:paragraph", {}, noteId);

  return noteId;
}
