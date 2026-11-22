// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
import type { NoteBlockModel } from "@virgultum/core/models";
import type { SurfaceBlockModel } from "@virgultum/core/runtime/gfx";
const primitiveTypes = new Set([
  "shape",
  "text",
  "brush",
  "highlighter",
  "connector",
  "group",
]);
/** Check stored geometry before importing a painter. Missing or still
 * materializing elements must not turn an unsupported scene into a blank one. */
export function readRasterSurface(store: Store) {
  const root = store.root;
  if (!root || root.children.length !== root.yBlock.get("sys:children").length)
    return;
  const surface = root.children.find((b) => b.flavour === "myoxus:surface") as
    SurfaceBlockModel | undefined;
  if (
    !surface ||
    surface.yBlock.get("sys:children").length ||
    !root.children.every(
      (m) =>
        m === surface ||
        (m.flavour === "myoxus:note" &&
          (m as NoteBlockModel).props.displayMode === "doc"),
    )
  )
    return;
  const values = surface.elements.getValue();
  if (!values || values.size !== surface.elementModels.length) return;
  for (const el of values.values()) {
    const type = el.get("type");
    if (typeof type !== "string" || !primitiveTypes.has(type)) return;
  }
  return surface;
}
