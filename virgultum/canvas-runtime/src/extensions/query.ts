import type { Connectable, NoteBlockModel } from "@virgultum/core/models";
import type { GfxModel } from "@virgultum/core/runtime/gfx";
import type { BlockModel } from "@virgultum/core/store";

export function isConnectable(
  element: GfxModel | null,
): element is Connectable {
  return !!element && element.connectable;
}

export function isNoteBlock(
  element: BlockModel | GfxModel | null,
): element is NoteBlockModel {
  return !!element && "flavour" in element && element.flavour === "myoxus:note";
}
