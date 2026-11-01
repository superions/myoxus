import { DefaultTool, EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { Bound, type IVec } from "@virgultum/global/gfx";
import type { ConnectorElementModel } from "@virgultum/model";
import type { BlockComponent } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import * as Y from "yjs";

import { EdgelessConnectorLabelEditor } from "./edgeless-connector-label-editor";

export function mountConnectorLabelEditor(
  connector: ConnectorElementModel,
  edgeless: BlockComponent,
  point?: IVec,
) {
  const mountElm = edgeless.querySelector(".edgeless-mount-point");
  if (!mountElm) {
    throw new VirgultumError(
      ErrorCode.ValueNotExists,
      "edgeless block's mount point does not exist",
    );
  }

  if (connector.labelEditing) {
    const currentEditor = Array.from(
      mountElm.querySelectorAll("edgeless-connector-label-editor"),
    ).find(
      (editor): editor is EdgelessConnectorLabelEditor =>
        editor instanceof EdgelessConnectorLabelEditor &&
        editor.connector === connector,
    );

    currentEditor?.inlineEditor?.focusEnd();
    return;
  }

  const gfx = edgeless.std.get(GfxControllerIdentifier);

  gfx.tool.setTool(DefaultTool);
  gfx.selection.set({
    elements: [connector.id],
    editing: true,
  });
  connector.labelEditing = true;

  if (!connector.text) {
    const text = new Y.Text();
    const labelOffset = connector.labelOffset;
    let labelXYWH = connector.labelXYWH ?? [0, 0, 16, 16];

    if (point) {
      const center = connector.getNearestPoint(point);
      const distance = connector.getOffsetDistanceByPoint(center as IVec);
      const bounds = Bound.fromXYWH(labelXYWH);
      bounds.center = center;
      labelOffset.distance = distance;
      labelXYWH = bounds.toXYWH();
    }

    edgeless.std.get(EdgelessCRUDIdentifier).updateElement(connector.id, {
      text,
      labelXYWH,
      labelOffset: { ...labelOffset },
    });
  }

  const editor = new EdgelessConnectorLabelEditor();
  editor.connector = connector;

  mountElm.append(editor);
  editor.updateComplete
    .then(() => {
      editor.inlineEditor?.focusEnd();
    })
    .catch(console.error);
}
