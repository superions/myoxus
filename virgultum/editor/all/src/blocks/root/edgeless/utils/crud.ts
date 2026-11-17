import { isNoteBlock } from "@virgultum/canvas-runtime/surface";
import type { Connectable } from "@virgultum/core/models";
import {
  type GfxModel,
  isGfxGroupCompatibleModel,
} from "@virgultum/core/runtime/gfx";

import type { EdgelessRootBlockComponent } from "../index.js";
import { isConnectable } from "./query.js";

/**
 * Use deleteElementsV2 instead.
 * @deprecated
 */
export function deleteElements(
  edgeless: EdgelessRootBlockComponent,
  elements: GfxModel[],
) {
  if (
    edgeless.store.readonly ||
    elements.some((element) => edgeless.store.hasFixedText(element.id))
  )
    return;
  const set = new Set(elements);
  const { service } = edgeless;

  elements.forEach((element) => {
    if (isConnectable(element)) {
      const connectors = service.getConnectors(element as Connectable);
      connectors.forEach((connector) => set.add(connector));
    }
  });

  set.forEach((element) => {
    if (isNoteBlock(element)) {
      const children = edgeless.store.root?.children ?? [];
      // FIXME: should always keep at least 1 note
      if (children.length > 1) {
        // Embedded groups own Surface siblings, not document-tree children.
        // Remove those owned elements before deleting the containing Note;
        // otherwise a later diagram can adopt the orphaned semantic IDs.
        const descendants = [...element.children];
        for (const child of descendants) {
          if (isGfxGroupCompatibleModel(child)) service.removeElement(child.id);
          else descendants.push(...child.children);
        }
        edgeless.store.deleteBlock(element);
      }
    } else {
      service.removeElement(element.id);
    }
  });
}
