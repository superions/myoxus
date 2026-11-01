import { sourceMindmapSelection } from "../actions/mindmap-source";
import { SurfaceBlockModel } from "@virgultum/editor/blocks/surface";
import { NoteBlockModel, RootBlockModel } from "@virgultum/editor/model";
import { matchModels } from "@virgultum/editor/shared/utils";
import type { BlockComponent } from "@virgultum/editor/std";
import type { GfxModel } from "@virgultum/editor/std/gfx";

export function isMindMapRoot(element: GfxModel) {
  return sourceMindmapSelection(element)?.node.root ?? false;
}
export function isMindmapChild(element: GfxModel) {
  const selected = sourceMindmapSelection(element);
  return selected ? !selected.node.root : false;
}

export { getEdgelessCopilotWidget } from "./get-edgeless-copilot-widget";

export function findNoteBlockModel(blockElement: BlockComponent) {
  let curBlock = blockElement;
  while (curBlock) {
    if (matchModels(curBlock.model, [NoteBlockModel])) {
      return curBlock.model;
    }
    if (matchModels(curBlock.model, [RootBlockModel, SurfaceBlockModel])) {
      return null;
    }
    if (!curBlock.parentComponent) {
      break;
    }
    curBlock = curBlock.parentComponent;
  }
  return null;
}
