// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { on } from "@virgultum/core/utils";
import { DefaultTool } from "@virgultum/editor/blocks/surface";
import { IS_MAC } from "@virgultum/editor/global/env";
import {
  Bound,
  getCommonBoundWithRotation,
} from "@virgultum/editor/global/gfx";
import type { PointerEventState } from "@virgultum/editor/std";
import {
  BaseTool,
  type GfxModel,
  MouseButton,
} from "@virgultum/editor/std/gfx";
import { Subject } from "rxjs";

import { AIPanelControllerIdentifier } from "../widgets/ai-panel/controller";

type Point2D = [number, number];

function pointsMatch(a: Point2D, b: Point2D): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export class CopilotTool extends BaseTool {
  static override toolName = "copilot";

  readonly draggingAreaUpdated = new Subject<boolean | void>();

  dragStartPoint: Point2D = [0, 0];
  dragLastPoint: Point2D = [0, 0];

  private dragging = false;

  override get allowDragWithRightButton() {
    return true;
  }

  get area(): DOMRect {
    const minX = Math.min(this.dragStartPoint[0], this.dragLastPoint[0]);
    const minY = Math.min(this.dragStartPoint[1], this.dragLastPoint[1]);
    const maxX = Math.max(this.dragStartPoint[0], this.dragLastPoint[0]);
    const maxY = Math.max(this.dragStartPoint[1], this.dragLastPoint[1]);
    return new DOMRect(minX, minY, maxX - minX, maxY - minY);
  }

  get processing(): boolean {
    const panel = this.gfx.std.getOptional(AIPanelControllerIdentifier);
    return Boolean(panel && panel.state !== "hidden");
  }

  get selectedElements() {
    return this.gfx.selection.selectedElements;
  }

  private resetDragState(): void {
    this.dragging = false;
    this.dragStartPoint = [0, 0];
    this.dragLastPoint = [0, 0];
  }

  private isCopilotGesture(event: PointerEvent): boolean {
    if (event.button === MouseButton.SECONDARY) return true;
    const primaryModifier = IS_MAC ? event.metaKey : event.ctrlKey;
    return event.button === MouseButton.MAIN && primaryModifier;
  }

  abort(): void {
    this.resetDragState();
    this.gfx.tool.setTool(DefaultTool);
  }

  override activate(): void {
    this.gfx.viewport.locked = true;
  }

  override deactivate(): void {
    this.gfx.viewport.locked = false;
  }

  override dragStart(e: PointerEventState): void {
    if (this.processing) return;
    const point = this.gfx.viewport.toModelCoord(e.x, e.y) as Point2D;
    this.dragStartPoint = point;
    this.dragLastPoint = point;
    this.dragging = true;
    this.draggingAreaUpdated.next();
  }

  override dragMove(e: PointerEventState): void {
    if (!this.dragging) return;
    this.dragLastPoint = this.gfx.viewport.toModelCoord(e.x, e.y) as Point2D;

    const rect = this.area;
    if (rect.width > 0 && rect.height > 0) {
      const bound = new Bound(rect.x, rect.y, rect.width, rect.height);
      const uniqueIds = Array.from(
        new Set(this.gfx.getElementsByBound(bound).map((el) => el.id)),
      );
      this.gfx.selection.set({
        elements: uniqueIds,
        editing: false,
        inoperable: true,
      });
    }

    this.draggingAreaUpdated.next();
  }

  override dragEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.draggingAreaUpdated.next(true);
  }

  override mounted(): void {
    this.addHook("pointerDown", (downEvent) => {
      const dispose = on(document, "pointerup", (upEvent) => {
        if (
          this.isCopilotGesture(upEvent) &&
          pointsMatch(this.dragStartPoint, this.dragLastPoint)
        ) {
          this.abort();
        }
        dispose();
      });

      if (this.isCopilotGesture(downEvent.raw)) {
        this.resetDragState();
        this.controller.setTool(CopilotTool);
        return false;
      }

      return;
    });
  }

  override pointerDown(e: PointerEventState): void {
    if (this.processing) {
      e.raw.stopPropagation();
      return;
    }
    this.gfx.tool.setTool(DefaultTool);
  }

  updateDragPointsWith(selectedElements: GfxModel[], padding = 0): void {
    const expanded = getCommonBoundWithRotation(selectedElements).expand(
      padding / this.gfx.viewport.zoom,
    );
    this.dragStartPoint = expanded.tl as Point2D;
    this.dragLastPoint = expanded.br as Point2D;
  }

  updateSelectionWith(selectedElements: GfxModel[], padding = 0): void {
    const { selection } = this.gfx;
    selection.clear();
    this.updateDragPointsWith(selectedElements, padding);
    selection.set({
      elements: selectedElements.map((el) => el.id),
      editing: false,
      inoperable: true,
    });
    this.draggingAreaUpdated.next(true);
  }
}
