// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { isOrganizeSupportType } from "@myoxus/core/modules/organize/constants";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import type { DropTargetOptions } from "@myoxus/ui-facade";

import type { StructureTreeNodeDropEffect } from "../../tree";

export const organizeChildrenDropEffect: StructureTreeNodeDropEffect = (
  data,
) => {
  const instruction = data.treeInstruction?.type;
  if (
    (instruction === "reorder-above" || instruction === "reorder-below") &&
    data.source.data.entity?.type === "folder"
  ) {
    return "move";
  }
  return undefined;
};

export const organizeEmptyDropEffect: StructureTreeNodeDropEffect = (data) => {
  const sourceType = data.source.data.entity?.type;
  if (sourceType === "folder") return "move";
  if (sourceType && isOrganizeSupportType(sourceType)) return "link";
  return undefined;
};

export const organizeEmptyRootCanDrop: DropTargetOptions<MyoxusDNDData>["canDrop"] =
  (data) => {
    const type = data.source.data.entity?.type;
    return Boolean(type && isOrganizeSupportType(type));
  };
