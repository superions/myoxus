import type { Connectable, NoteBlockModel } from "@virgultum/model";
import type { GfxModel } from "@virgultum/std/gfx";
import type { BlockModel } from "@virgultum/store";

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
