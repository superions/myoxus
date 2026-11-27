import { OverlayIdentifier } from "@virgultum/canvas-runtime/surface";
import { type Bound } from "@virgultum/core/primitives/gfx";
import {
  type DragExtensionInitializeContext,
  type ExtensionDragMoveContext,
  type GfxModel,
  getGfxManagedOwner,
  InteractivityExtension,
} from "@virgultum/core/runtime/gfx";

import { AdaptiveStrideController } from "./adaptive-load-controller";
import type { SnapOverlay } from "./snap-overlay";

export class SnapExtension extends InteractivityExtension {
  static override key = "snap-manager";

  private static readonly MAX_ALIGN_SKIP_STRIDE = 3;

  private static readonly ALIGN_HEAVY_COST_MS = 5;

  private static readonly ALIGN_RECOVERY_COST_MS = 2;

  private static readonly GRID_SNAP_STEP = 20;

  private altBypass = false;

  private cleanupAltListeners?: () => void;

  get snapOverlay() {
    return this.std.getOptional(
      OverlayIdentifier("snap-manager"),
    ) as SnapOverlay;
  }

  override unmounted(): void {
    this.cleanupAltListeners?.();
    this.cleanupAltListeners = undefined;
    this.altBypass = false;
    super.unmounted();
  }

  override mounted(): void {
    if (typeof window !== "undefined") {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Alt") this.altBypass = true;
      };
      const onKeyUp = (event: KeyboardEvent) => {
        if (event.key === "Alt") this.altBypass = false;
      };
      const onBlur = () => {
        this.altBypass = false;
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("blur", onBlur);
      this.cleanupAltListeners = () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
      };
    }

    this.action.onDragInitialize(
      (initContext: DragExtensionInitializeContext) => {
        const snapOverlay = this.snapOverlay;

        if (!snapOverlay) {
          return {};
        }

        let alignBound: Bound | null = null;
        const alignStride = new AdaptiveStrideController({
          heavyCostMs: SnapExtension.ALIGN_HEAVY_COST_MS,
          maxStride: SnapExtension.MAX_ALIGN_SKIP_STRIDE,
          recoveryCostMs: SnapExtension.ALIGN_RECOVERY_COST_MS,
        });

        return {
          onDragStart() {
            alignBound = snapOverlay.setMovingElements(
              initContext.elements,
              initContext.elements.reduce((pre, elem) => {
                const managedOwner = getGfxManagedOwner(elem);
                if (managedOwner) pre.push(managedOwner);

                return pre;
              }, [] as GfxModel[]),
            );
            alignStride.reset();
          },
          onDragMove: (context: ExtensionDragMoveContext) => {
            if (
              context.elements.length === 0 ||
              !alignBound ||
              alignBound.w === 0 ||
              alignBound.h === 0
            ) {
              return;
            }

            if (this.altBypass) {
              snapOverlay.clear();
              return;
            }

            if (alignStride.shouldSkip()) {
              return;
            }

            const currentBound = alignBound.moveDelta(context.dx, context.dy);
            const alignStart = performance.now();
            const alignRst = snapOverlay.align(currentBound);
            const alignCost = performance.now() - alignStart;
            alignStride.reportCost(alignCost);

            const step = SnapExtension.GRID_SNAP_STEP;
            const gridDx =
              alignRst.dx !== 0
                ? alignRst.dx
                : Math.round(currentBound.x / step) * step - currentBound.x;
            const gridDy =
              alignRst.dy !== 0
                ? alignRst.dy
                : Math.round(currentBound.y / step) * step - currentBound.y;

            context.dx = gridDx + context.dx;
            context.dy = gridDy + context.dy;
          },
          clear() {
            alignBound = null;
            alignStride.reset();
            snapOverlay.clear();
          },
        };
      },
    );

    this.action.onElementResize(() => {
      const snapOverlay = this.snapOverlay;

      if (!snapOverlay) {
        return {};
      }

      return {
        onResizeStart(context) {
          snapOverlay.setMovingElements(context.elements);
        },
        onResizeMove(context) {
          const {
            handle,
            originalBound,
            scaleX,
            scaleY,
            handleSign,
            currentHandlePos,
            elements,
          } = context;
          const rotate = elements.length > 1 ? 0 : elements[0].rotate;
          const alignDirection: ("vertical" | "horizontal")[] = [];
          let switchDirection = false;
          let nx = handleSign.x;
          let ny = handleSign.y;

          if (handle.length > 6) {
            alignDirection.push("vertical", "horizontal");
          } else if (rotate % 90 === 0) {
            nx =
              handleSign.x * Math.cos((rotate / 180) * Math.PI) -
              handleSign.y * Math.sin((rotate / 180) * Math.PI);
            ny =
              handleSign.x * Math.sin((rotate / 180) * Math.PI) +
              handleSign.y * Math.cos((rotate / 180) * Math.PI);

            if (Math.abs(nx) > Math.abs(ny)) {
              alignDirection.push("horizontal");
            } else {
              alignDirection.push("vertical");
            }

            if (rotate % 180 !== 0) {
              switchDirection = true;
            }
          }

          if (alignDirection.length > 0) {
            const rst = snapOverlay.alignResize(
              currentHandlePos,
              alignDirection,
            );

            const dx = switchDirection ? ny * rst.dy : nx * rst.dx;
            const dy = switchDirection ? nx * rst.dx : ny * rst.dy;

            context.suggest({
              scaleX: scaleX + dx / originalBound.w,
              scaleY: scaleY + dy / originalBound.h,
            });
          }
        },
        onResizeEnd() {
          snapOverlay.clear();
        },
      };
    });
  }
}
