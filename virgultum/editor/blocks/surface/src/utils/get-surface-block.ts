import type { BlockStdScope } from "@virgultum/std";
import type { Store } from "@virgultum/store";

import type { SurfaceBlockComponent } from "../surface-block";
import type { SurfaceBlockModel } from "../surface-model";

export function getSurfaceBlock(doc: Store) {
  const blocks = doc.getBlocksByFlavour("myoxus:surface");
  return blocks.length !== 0 ? (blocks[0].model as SurfaceBlockModel) : null;
}

export function getSurfaceComponent(std: BlockStdScope) {
  const surface = getSurfaceBlock(std.store);
  if (!surface) return null;
  return std.view.getBlock(surface.id) as SurfaceBlockComponent | null;
}
