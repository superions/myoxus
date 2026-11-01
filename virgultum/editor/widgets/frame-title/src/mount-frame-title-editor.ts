import { DefaultTool } from "@virgultum/block-surface";
import { VirgultumError } from "@virgultum/global/exceptions";
import type { FrameBlockModel } from "@virgultum/model";
import type { BlockComponent } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";

import { EdgelessFrameTitleEditor } from "./edgeless-frame-title-editor";

export function mountFrameTitleEditor(
  frame: FrameBlockModel,
  edgeless: BlockComponent,
) {
  const mountElm = edgeless.querySelector(".edgeless-mount-point");
  if (!mountElm) {
    throw new VirgultumError(
      VirgultumError.ErrorCode.ValueNotExists,
      "edgeless block's mount point does not exist",
    );
  }

  const gfx = edgeless.std.get(GfxControllerIdentifier);

  gfx.tool.setTool(DefaultTool);
  gfx.selection.set({
    elements: [frame.id],
    editing: true,
  });

  const frameEditor = new EdgelessFrameTitleEditor();
  frameEditor.frameModel = frame;
  frameEditor.edgeless = edgeless;

  mountElm.append(frameEditor);
}
