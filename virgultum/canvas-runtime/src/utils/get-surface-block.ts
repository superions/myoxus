import type { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import type { Store } from "@virgultum/core/store";

import { SurfaceBlockComponent } from "../native-surface-block";
import type { SurfaceBlockModel } from "../surface-model";

export function getSurfaceBlock(doc: Store) {
  const blocks = doc.getBlocksByFlavour("myoxus:surface");
  return blocks.length !== 0 ? (blocks[0].model as SurfaceBlockModel) : null;
}

export function getSurfaceComponent(std: BlockStdScope) {
  const view = std.getOptional(GfxControllerIdentifier)?.surfaceComponent;
  return view instanceof SurfaceBlockComponent ? view : null;
}
