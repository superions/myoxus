import type { FrameBlockModel } from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";

export function getFrameBlock(doc: Store) {
  const blocks = doc.getBlocksByFlavour("myoxus:frame");
  return blocks.length !== 0 ? (blocks[0].model as FrameBlockModel) : null;
}
