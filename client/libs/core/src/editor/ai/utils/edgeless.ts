// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { SurfaceBlockModel } from "@virgultum/editor/blocks/surface";
import { NoteBlockModel, RootBlockModel } from "@virgultum/editor/model";
import { matchModels } from "@virgultum/editor/shared/utils";
import type { BlockComponent } from "@virgultum/editor/std";
import type { GfxModel } from "@virgultum/editor/std/gfx";

import { sourceMindmapSelection } from "../actions/mindmap-source";

export { getEdgelessCopilotWidget } from "./get-edgeless-copilot-widget";

export function isMindMapRoot(element: GfxModel): boolean {
  return sourceMindmapSelection(element)?.node.root ?? false;
}

export function isMindmapChild(element: GfxModel): boolean {
  const selected = sourceMindmapSelection(element);
  return selected ? !selected.node.root : false;
}

export function findNoteBlockModel(block: BlockComponent) {
  let cursor: BlockComponent | null = block;
  while (cursor) {
    if (matchModels(cursor.model, [NoteBlockModel])) {
      return cursor.model;
    }
    if (matchModels(cursor.model, [RootBlockModel, SurfaceBlockModel])) {
      return null;
    }
    cursor = cursor.parentComponent ?? null;
  }
  return null;
}
