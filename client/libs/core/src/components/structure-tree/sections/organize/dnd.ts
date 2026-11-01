import { isOrganizeSupportType } from "@myoxus/core/modules/organize/constants";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import type { DropTargetOptions } from "@myoxus/ui-facade";

import type { StructureTreeNodeDropEffect } from "../../tree";

export const organizeChildrenDropEffect: StructureTreeNodeDropEffect = (
  data,
) => {
  if (
    data.treeInstruction?.type === "reorder-above" ||
    data.treeInstruction?.type === "reorder-below"
  ) {
    if (data.source.data.entity?.type === "folder") {
      return "move";
    }
  } else {
    return; // not supported
  }
  return;
};

export const organizeEmptyDropEffect: StructureTreeNodeDropEffect = (data) => {
  const sourceType = data.source.data.entity?.type;
  if (sourceType === "folder") return "move";
  if (sourceType && isOrganizeSupportType(sourceType)) {
    return "link";
  }
  return;
};

/**
 * Check whether the data can be dropped on the empty state of the organize section
 */
export const organizeEmptyRootCanDrop: DropTargetOptions<MyoxusDNDData>["canDrop"] =
  (data) => {
    const type = data.source.data.entity?.type;
    return !!type && isOrganizeSupportType(type);
  };
