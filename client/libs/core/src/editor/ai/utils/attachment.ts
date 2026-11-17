import { AttachmentBlockModel } from "@virgultum/editor/model";
import type { BlockModel } from "@virgultum/editor/store";
import type { GfxModel } from "@virgultum/core/runtime/gfx";

export function isAttachment(
  model: GfxModel | BlockModel,
): model is AttachmentBlockModel {
  return model instanceof AttachmentBlockModel;
}
