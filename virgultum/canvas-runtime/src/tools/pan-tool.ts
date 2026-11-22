import { Signal } from "@preact/signals-core";
import {
  DefaultTool,
  EdgelessLegacySlotIdentifier,
} from "@virgultum/canvas-runtime/surface";
import { on } from "@virgultum/core/utils";
import type { PointerEventState } from "@virgultum/core/runtime";
import {
  BaseTool,
  MouseButton,
  type ToolOptions,
} from "@virgultum/core/runtime/gfx";
import { cameraPan } from "../tool/panning-utils";

interface RestorablePresentToolOptions {
  mode?: string; // 'fit' | 'fill', simplified to string for local use
  restoredAfterPan?: boolean;
}

export type PanToolOption = {
  panning: boolean;
};

export class PanTool extends BaseTool<PanToolOption> {
  static override toolName = "pan";

  private readonly pan = cameraPan(this.gfx.viewport);

  private _restoreAfterTemporaryPan: (() => void) | null = null;

  readonly panning$ = new Signal<boolean>(false);

  override get allowDragWithRightButton(): boolean {
    return true;
  }

  override dragEnd(_: PointerEventState): void {
    this.pan.end();
    this.panning$.value = false;
    this._restoreAfterTemporaryPan?.();
    this._restoreAfterTemporaryPan = null;
  }

  override dragMove(e: PointerEventState): void {
    this.pan.move(e.x, e.y);
  }

  override dragStart(e: PointerEventState): void {
    this.pan.start(e.x, e.y);
    this.panning$.value = true;
  }

  override mounted(): void {
    this.addHook("pointerDown", (evt) => {
      const shouldPanWithMiddle = evt.raw.button === MouseButton.MIDDLE;

      if (!shouldPanWithMiddle) {
        return;
      }

      const currentTool = this.controller.currentToolOption$.peek();
      const { toolType, options: originalToolOptions } = currentTool;

      if (toolType?.toolName === PanTool.toolName) {
        return;
      }

      evt.raw.preventDefault();

      const selectionToRestore = this.gfx.selection.surfaceSelections.slice();

      const restoreToPrevious = () => {
        if (!toolType) {
          this.gfx.selection.set(selectionToRestore);
          return;
        }
        // restore to DefaultTool if previous tool is CopilotTool
        if (toolType.toolName === "copilot") {
          this.controller.setTool(DefaultTool);
          this.gfx.selection.set(selectionToRestore);
          return;
        }

        let finalOptions: ToolOptions<BaseTool<any>> | undefined =
          originalToolOptions;
        if (toolType.toolName === "frameNavigator") {
          // When restoring PresentTool (frameNavigator) after a temporary pan (e.g., via middle mouse button),
          // set 'restoredAfterPan' to true. This allows PresentTool to avoid an unwanted viewport reset
          // and maintain the panned position.
          const currentPresentOptions = originalToolOptions as
            RestorablePresentToolOptions | undefined;
          finalOptions = {
            ...currentPresentOptions,
            restoredAfterPan: true,
          } as RestorablePresentToolOptions;
        }
        this.controller.setTool(toolType, finalOptions);
        this.gfx.selection.set(selectionToRestore);
      };
      this._restoreAfterTemporaryPan = restoreToPrevious;

      // If in presentation mode, disable black background after middle mouse drag
      if (toolType?.toolName === "frameNavigator") {
        const slots = this.std.get(EdgelessLegacySlotIdentifier);
        slots.navigatorSettingUpdated.next({
          blackBackground: false,
        });
      }

      this.controller.setTool(PanTool, {
        panning: true,
      });

      const dispose = on(document, "pointerup", (evt) => {
        if (evt.button === MouseButton.MIDDLE) {
          this._restoreAfterTemporaryPan?.();
          this._restoreAfterTemporaryPan = null;
        }
        dispose();
      });

      return false;
    });
  }

  override unmounted(): void {
    this.pan.cancel();
    this._restoreAfterTemporaryPan = null;
  }
}
