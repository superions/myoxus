import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { VirgultumError } from "@virgultum/core/primitives/exceptions";
import type { FrameBlockModel } from "@virgultum/core/models";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";

import { EdgelessFrameTitleEditor } from "./native-frame-title-editor";

export function mountFrameTitleEditor(
  frame: FrameBlockModel,
  edgeless: BlockComponent,
) {
  if (edgeless.store.readonly || frame.isLocked()) return;
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
