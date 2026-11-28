// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { DragFromVirgultum, DragPayload } from "@virgultum/core/runtime";
import type { SliceSnapshot } from "@virgultum/core/store";

export const MYOXUS_DRAG_HANDLE_WIDGET = "myoxus-drag-handle-widget";

export type DragHandleMode = "block" | "gfx" | null;

export type HoverBounds = Pick<DOMRect, "left" | "top" | "width" | "height">;

export interface DragBlockEntity {
  type: "blocks";
  /** Origin mode of the dragged selection (`block` in Notes/Page or `gfx` on canvas). */
  fromMode?: "block" | "gfx";
  snapshot?: SliceSnapshot;
  modelIds: string[];
}

export type DragBlockPayload = DragPayload<DragBlockEntity, DragFromVirgultum>;

declare module "@virgultum/core/runtime" {
  interface DNDEntity {
    blocks: DragBlockPayload;
  }
}
