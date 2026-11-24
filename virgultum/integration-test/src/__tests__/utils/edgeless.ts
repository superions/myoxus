import type {
  EdgelessRootBlockComponent,
  PageRootBlockComponent,
} from "@virgultum/editor/blocks/root";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { SurfaceBlockComponent } from "@virgultum/editor/blocks/surface";
import type { Store } from "@virgultum/editor/store";

import type { TestMyoxusEditorContainer } from "../../index.js";

export function getSurface(doc: Store, editor: TestMyoxusEditorContainer) {
  const surface = editor.host?.std.get(
    GfxControllerIdentifier,
  ).surfaceComponent;
  if (
    !(surface instanceof SurfaceBlockComponent) ||
    surface.model.store !== doc
  )
    throw new Error(
      "The active Canvas has no mounted surface for this document",
    );
  return surface;
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
