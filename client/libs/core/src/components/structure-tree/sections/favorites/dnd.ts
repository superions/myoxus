import { isFavoriteSupportType } from "@myoxus/core/modules/favorite";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import type { DropTargetOptions } from "@myoxus/ui-facade";

import type { StructureTreeNodeDropEffect } from "../../tree";

export const favoriteChildrenDropEffect: StructureTreeNodeDropEffect = (
  data,
) => {
  if (
    data.treeInstruction?.type === "reorder-above" ||
    data.treeInstruction?.type === "reorder-below"
  ) {
    if (
      data.source.data.from?.at === "structure-tree:favorite:list" &&
      data.source.data.entity?.type &&
      isFavoriteSupportType(data.source.data.entity.type)
    ) {
      return "move";
    } else if (
      data.source.data.entity?.type &&
      isFavoriteSupportType(data.source.data.entity.type)
    ) {
      return "link";
    }
  }
  return; // not supported
};

export const favoriteRootDropEffect: StructureTreeNodeDropEffect = (data) => {
  const sourceType = data.source.data.entity?.type;
  if (sourceType && isFavoriteSupportType(sourceType)) {
    return "link";
  }
  return;
};

export const favoriteRootCanDrop: DropTargetOptions<MyoxusDNDData>["canDrop"] =
  (data) => {
    return data.source.data.entity?.type
      ? isFavoriteSupportType(data.source.data.entity.type)
      : false;
  };

export const favoriteChildrenCanDrop: DropTargetOptions<MyoxusDNDData>["canDrop"] =
  // Same as favoriteRootCanDrop
  (data) => favoriteRootCanDrop(data);
