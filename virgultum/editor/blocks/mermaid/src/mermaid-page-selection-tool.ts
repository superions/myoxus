// SPDX-License-Identifier: AGPL-3.0-or-later

import { DefaultModeDragType, DefaultTool } from "@virgultum/block-surface";
import { IS_MAC } from "@virgultum/global/env";
import type { PointerEventState } from "@virgultum/std";
import type { GfxModel } from "@virgultum/std/gfx";

import type { MermaidPageSelectionOperation } from "./mermaid-page-selection-controller.js";
import type { MermaidPageSelectionTool as MermaidPageSelectionToolMode } from "./mermaid-page-selection-state.js";

type MermaidPageSelectionToolConfiguration = {
  readonly onAltClone?: () => Promise<void> | void;
  readonly onGestureChange: (active: boolean) => void;
  readonly onSelectionOperation: (
    operation: MermaidPageSelectionOperation,
    baseIds: readonly string[],
    candidateIds: readonly string[],
  ) => void;
  readonly resolveMode: () => MermaidPageSelectionToolMode;
  readonly resolveOrderedSelectableIds: () => readonly string[];
  readonly resolveSelectedIds: () => readonly string[];
};

type BoxSelectionOperation = "add" | "replace" | "subtract";

const EMPTY_DRAG_AREA = {
  endX: 0,
  endY: 0,
  h: 0,
  startX: 0,
  startY: 0,
  w: 0,
  x: 0,
  y: 0,
} as const;

/**
 * Scoped Page-mode specialization of Virgultum's native DefaultTool.
 *
 * Pointer and box are internal modes of this single registered tool. Switching
 * them never calls ToolController.setTool(), so the native SurfaceSelection is
 * retained. Hit testing, dragging-area geometry and edge scrolling remain
 * owned by DefaultTool and InteractivityIdentifier.
 */
export class MermaidPageSelectionTool extends DefaultTool {
  static override toolName = "default";

  private _baseSelection: readonly string[] = [];
  private _boxOperation: BoxSelectionOperation = "replace";
  private _configuration: MermaidPageSelectionToolConfiguration | null = null;
  private _gestureActive = false;

  configure(configuration: MermaidPageSelectionToolConfiguration) {
    this._configuration = configuration;
  }

  private get mode() {
    return this._configuration?.resolveMode() ?? "pointer";
  }

  private orderedAllowedSelection(ids: readonly string[]) {
    const selected = new Set(ids);
    return (this._configuration?.resolveOrderedSelectableIds() ?? []).filter(
      (id) => selected.has(id),
    );
  }

  private modelPointFromView(x: number, y: number) {
    const viewport = this.gfx.viewport;
    // PointerEventState view coordinates are already physical pixels relative
    // to this scoped viewport. In an embedded Note, GFX `viewScale` compensates
    // the outer canvas transform while painting; dividing these coordinates by
    // it again moves a tight selection box away from the visible objects.
    return [
      viewport.viewportX + x / viewport.zoom,
      viewport.viewportY + y / viewport.zoom,
    ] as const;
  }

  private resolvedBoxSelectionElements() {
    const viewBox = this.controller.draggingViewArea$.peek();
    const [startX, startY] = this.modelPointFromView(
      viewBox.startX,
      viewBox.startY,
    );
    const [endX, endY] = this.modelPointFromView(viewBox.endX, viewBox.endY);
    return (
      this.interactivity?.handleBoxSelection({
        box: {
          endX,
          endY,
          h: Math.abs(endY - startY),
          startX,
          startY,
          w: Math.abs(endX - startX),
          x: Math.min(startX, endX),
          y: Math.min(startY, endY),
        },
      }) ?? []
    );
  }

  private setGestureActive(active: boolean) {
    if (active === this._gestureActive) return;
    this._gestureActive = active;
    this._configuration?.onGestureChange(active);
  }

  private restoreGestureBaseSelection() {
    this._configuration?.onSelectionOperation(
      "replace",
      this._baseSelection,
      this._baseSelection,
    );
  }

  private applyClickSelection(event: PointerEventState) {
    const baseSelection = this.orderedAllowedSelection(
      this._configuration?.resolveSelectedIds() ?? this.selection.selectedIds,
    );
    const [x, y] = this.modelPointFromView(event.x, event.y);
    const hitIds = new Set(
      this.interactivity
        ?.handleBoxSelection({
          box: {
            endX: x + 0.5,
            endY: y + 0.5,
            h: 1,
            startX: x - 0.5,
            startY: y - 0.5,
            w: 1,
            x: x - 0.5,
            y: y - 0.5,
          },
        })
        .map((element) => element.id) ?? [],
    );
    // Scoped Mermaid projections intentionally do not install a second native
    // element-selection configuration. Reuse the exact GFX bound hit-test of
    // box selection for a below-threshold click and then apply the family
    // allow-list/order through the one Page selection controller.
    const changedId = (
      this._configuration?.resolveOrderedSelectableIds() ?? []
    ).findLast((id) => hitIds.has(id));
    const hasToggleModifier = event.keys.shift || event.keys.cmd;
    const operation: MermaidPageSelectionOperation = event.keys.alt
      ? "subtract"
      : hasToggleModifier
        ? "toggle"
        : "replace";
    this._configuration?.onSelectionOperation(
      operation,
      baseSelection,
      changedId ? [changedId] : [],
    );
  }

  override click(event: PointerEventState) {
    if (this.mode === "pointer") {
      this.interactivity?.dispatchEvent("click", event);
      return;
    }
    if (this.doc.readonly) return;
    if (IS_MAC && event.raw.ctrlKey && !event.raw.metaKey) return;
    this.applyClickSelection(event);
    this.interactivity?.dispatchEvent("click", event);
  }

  protected override resolveDragType(_event: PointerEventState) {
    if (this.mode === "box") return DefaultModeDragType.Selecting;
    return DefaultModeDragType.None;
  }

  protected override applyBoxSelection(_elements: GfxModel[]) {
    const hits = this.orderedAllowedSelection(
      this.resolvedBoxSelectionElements().map((element) => element.id),
    );
    this._configuration?.onSelectionOperation(
      this._boxOperation,
      this._baseSelection,
      hits,
    );
  }

  protected override dispatchDragStart(event: PointerEventState) {
    return this.mode === "box" ? {} : super.dispatchDragStart(event);
  }

  protected override dispatchDragMove(event: PointerEventState) {
    if (this.mode !== "box") super.dispatchDragMove(event);
  }

  protected override dispatchDragEnd(event: PointerEventState) {
    if (this.mode !== "box") super.dispatchDragEnd(event);
  }

  protected override async routeAltClone() {
    await this._configuration?.onAltClone?.();
  }

  override async dragStart(event: PointerEventState) {
    if (IS_MAC && event.raw.ctrlKey && !event.raw.metaKey) return;
    if (this.mode === "box") {
      this._baseSelection = this.orderedAllowedSelection(
        this._configuration?.resolveSelectedIds() ?? this.selection.selectedIds,
      );
      this._boxOperation = event.keys.alt
        ? "subtract"
        : event.keys.shift || event.keys.cmd
          ? "add"
          : "replace";
      // The host must pause owner persistence before DefaultTool begins its
      // asynchronous native drag lifecycle; reporting the gesture afterwards
      // leaves a window in which Surface readback can write during selection.
      this.setGestureActive(true);
    }
    await super.dragStart(event);
    if (
      this.mode === "box" &&
      (!this.movementDragging ||
        this.dragType !== DefaultModeDragType.Selecting)
    ) {
      this.setGestureActive(false);
    }
  }

  override dragEnd(event: PointerEventState) {
    if (
      this._gestureActive &&
      (event.raw.type === "pointercancel" ||
        event.raw.type === "lostpointercapture")
    ) {
      this.restoreGestureBaseSelection();
    }
    super.dragEnd(event);
    this.setGestureActive(false);
  }

  override deactivate() {
    super.deactivate();
    this.setGestureActive(false);
  }

  override pointerDown(event: PointerEventState) {
    if (this.mode !== "box") super.pointerDown(event);
  }

  override pointerMove(event: PointerEventState) {
    if (this.mode !== "box") super.pointerMove(event);
  }

  override pointerUp(event: PointerEventState) {
    if (this.mode !== "box") super.pointerUp(event);
  }

  override doubleClick(event: PointerEventState) {
    if (this.mode !== "box") super.doubleClick(event);
  }

  cancelPageGesture() {
    if (this._gestureActive) this.restoreGestureBaseSelection();
    this.cancelLifecycle();
    this.controller.dragging$.value = false;
    this.controller.draggingArea$.value = { ...EMPTY_DRAG_AREA };
    this.controller.draggingViewArea$.value = { ...EMPTY_DRAG_AREA };
    this.setGestureActive(false);
  }
}
