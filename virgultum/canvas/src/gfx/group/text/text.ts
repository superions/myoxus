import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  ErrorCode,
  VirgultumError,
} from "@virgultum/core/primitives/exceptions";
import type { GroupElementModel } from "@virgultum/core/models";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";

import { EdgelessGroupTitleEditor } from "./edgeless-group-title-editor";

export function mountGroupTitleEditor(
  group: GroupElementModel,
  edgeless: BlockComponent,
) {
  const mountElm = edgeless.querySelector(".edgeless-mount-point");
  if (!mountElm) {
    throw new VirgultumError(
      ErrorCode.ValueNotExists,
      "edgeless block's mount point does not exist",
    );
  }

  const gfx = edgeless.std.get(GfxControllerIdentifier);

  gfx.tool.setTool(DefaultTool);
  gfx.selection.set({
    elements: [group.id],
    editing: true,
  });

  const groupEditor = new EdgelessGroupTitleEditor();
  groupEditor.group = group;

  mountElm.append(groupEditor);
}
