import { DefaultTool, OverlayIdentifier } from "@virgultum/block-surface";
import { Bound, type IPoint, type IVec, Vec } from "@virgultum/global/gfx";
import type { FrameBlockModel } from "@virgultum/model";
import { EditPropsStore, TelemetryProvider } from "@virgultum/shared/services";
import type { PointerEventState } from "@virgultum/std";
import { BaseTool, getTopElements } from "@virgultum/std/gfx";
import { Text } from "@virgultum/store";
import * as Y from "yjs";

import {
  EdgelessFrameManagerIdentifier,
  type FrameOverlay,
} from "./frame-manager";

export class FrameTool extends BaseTool {
  static override toolName = "frame";

  private _frame: FrameBlockModel | null = null;

  private _startPoint: IVec | null = null;

  get frameManager() {
    return this.std.get(EdgelessFrameManagerIdentifier);
  }

  get frameOverlay() {
    return this.std.get(OverlayIdentifier("frame")) as FrameOverlay;
  }

  private _toModelCoord(p: IPoint): IVec {
    return this.gfx.viewport.toModelCoord(p.x, p.y);
  }

  override dragEnd(): void {
    if (this._frame) {
      const frame = this._frame;
      frame.pop("xywh");
      this.gfx.tool.setTool(DefaultTool);
      this.gfx.selection.set({
        elements: [frame.id],
        editing: false,
      });

      this.frameManager.addElementsToFrame(
        frame,
        getTopElements(this.frameManager.getElementsInFrameBound(frame)),
      );
    }

    this._frame = null;
    this._startPoint = null;
    this.frameOverlay.clear();
  }

  override dragMove(e: PointerEventState): void {
    if (!this._startPoint) return;

    const currentPoint = this._toModelCoord(e.point);
    if (Vec.dist(this._startPoint, currentPoint) < 8 && !this._frame) return;

    if (!this._frame) {
      const frames = this.gfx.layer.blocks.filter(
        (block) => block.flavour === "myoxus:frame",
      ) as FrameBlockModel[];

      const props = this.std
        .get(EditPropsStore)
        .applyLastProps("myoxus:frame", {
          title: new Text(new Y.Text(`Frame ${frames.length + 1}`)),
          xywh: Bound.fromPoints([this._startPoint, currentPoint]).serialize(),
          index: this.gfx.layer.generateIndex(true),
          presentationIndex: this.frameManager.generatePresentationIndex(),
        });

      const id = this.doc.addBlock("myoxus:frame", props, this.gfx.surface);

      this.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "canvas:draw",
        page: "whiteboard editor",
        module: "toolbar",
        segment: "toolbar",
        type: "frame",
      });
      this._frame = this.gfx.getElementById(id) as FrameBlockModel;
      this._frame.stash("xywh");
      return;
    }

    this.gfx.doc.updateBlock(this._frame, {
      xywh: Bound.fromPoints([this._startPoint, currentPoint]).serialize(),
    });

    this.frameOverlay.highlight(this._frame, true);
  }

  override dragStart(e: PointerEventState): void {
    this.doc.captureSync();
    const { point } = e;
    this._startPoint = this._toModelCoord(point);
  }
}
