// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import type { DropTargetDropEvent, DropTargetOptions } from "@myoxus/ui-facade";

import type { StructureTreeNodeDropEffect } from "../tree";
import type { NodeOperation } from "../tree/types";

/**
 * Shared contract implemented by every typed structure-tree node.
 * Center drops (`make-child`) are handled by the node itself while edge drops
 * (`reorder-above`, `reorder-below`, `reparent`) delegate to the parent node.
 */
export interface GenericStructureTreeNode {
  location?: MyoxusDNDData["draggable"]["from"];
  reorderable?: boolean;
  operations?: NodeOperation[];
  canDrop?: DropTargetOptions<MyoxusDNDData>["canDrop"];
  onDrop?: (data: DropTargetDropEvent<MyoxusDNDData>) => void;
  dropEffect?: StructureTreeNodeDropEffect;
  parentPath: string[];
}
