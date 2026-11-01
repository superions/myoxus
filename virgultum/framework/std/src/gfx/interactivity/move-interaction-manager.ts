// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `move-interaction-manager.ts` - P-VIRG-ARCH-G-02.
 *
 * Move-Teilmanager fuer den GFX-Interactivity-Manager.
 * Aus `interactivity/manager.ts` extrahiert ohne Verhaltensaenderung
 * (pure Delegation). Beheimatet:
 *
 *   - `handleElementMove` (L193-405 in manager.ts)
 *
 * Der Host (`InteractivityManager`) haelt eine Instanz und
 * delegiert die oeffentliche Methode weiterhin, damit externe
 * Konsumenten (z.B. `default-tool.ts:171`) unveraendert
 * funktionieren.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §6.1.1
 *      (P-VIRG-ARCH-G-01 — Verfeinerte Verantwortungs-Kartierung)
 */

import { Bound, Point } from "@virgultum/global/gfx";

import type { GfxModel } from "../model/model.js";
import { createRafCoalescer } from "../raf-coalescer.js";
import type { InteractivityActionAPI } from "./extension/base.js";
import type { InteractivityManager } from "./manager.js";
import type { SafeExecuteContext } from "./safe-execute-context.js";
import type {
  DragExtensionInitializeContext,
  DragInitializationOption,
  ExtensionDragEndContext,
  ExtensionDragMoveContext,
  ExtensionDragStartContext,
} from "./types/drag.js";

const DRAG_MOVE_RAF_THRESHOLD = 100;
const DRAG_MOVE_HEAVY_COST_MS = 4;

const shouldAllowDragMoveCoalescing = (
  elements: { model: GfxModel }[],
): boolean => {
  return elements.every(({ model }) => {
    const isConnector = "type" in model && model.type === "connector";
    const isContainer = "childIds" in model;

    return !isConnector && !isContainer;
  });
};

/**
 * Move-Teilmanager. Erhaelt eine Back-Reference auf den Host
 * (`InteractivityManager`), weil die Move-Logik auf `gfx`,
 * `std`, `interactExtensions`, `activeInteraction$` und
 * `_safeExecute` des Hosts zugreift.
 *
 * **Negativ-Abnahme:** Wenn der Sub-Manager durch no-op-Stubs
 * ersetzt wird, MUSS die E2E-Spec
 * `e2e/edgeless/move/` rot werden.
 */
export class MoveInteractionManager {
  constructor(private readonly host: InteractivityManager) {}

  /**
   * Vor G-02 `handleElementMove` (L193-405) im
   * `InteractivityManager`. Verhalten unveraendert.
   */
  handleElementMove(options: DragInitializationOption): void {
    let cancelledByExt = false;

    const context: DragExtensionInitializeContext = {
      /**
       * The elements that are being dragged
       */
      elements: this.host.resolveMoveElements(options.movingElements),

      preventDefault: () => {
        cancelledByExt = true;
      },

      dragStartPos: Point.from(
        this.host._gfx.viewport.toModelCoordFromClientCoord([
          options.event.x,
          options.event.y,
        ]),
      ),
    };
    const extension = this.host._interactExtensions;
    const activeExtensionHandlers = Array.from(
      extension.values().map((ext) => {
        return (ext.action as InteractivityActionAPI).emit(
          "dragInitialize",
          context,
        );
      }),
    );

    if (cancelledByExt) {
      activeExtensionHandlers.forEach((handler) => handler?.clear?.());
      return;
    }

    const host = this.host._std.host;
    const { event } = options;
    const internal = {
      elements: context.elements.map((model) => {
        return {
          view: this.host._gfx.view.get(model)!,
          originalBound: Bound.deserialize(model.xywh),
          model: model,
        };
      }),
      dragStartPos: Point.from(
        this.host._gfx.viewport.toModelCoordFromClientCoord([event.x, event.y]),
      ),
    };
    let dragLastPos = internal.dragStartPos;
    let lastEvent = event;
    let lastMoveDelta: [number, number] | null = null;
    let finished = false;
    const canCoalesceDragMove = shouldAllowDragMoveCoalescing(
      internal.elements,
    );
    let shouldCoalesceDragMove =
      canCoalesceDragMove &&
      internal.elements.length >= DRAG_MOVE_RAF_THRESHOLD;

    const applyDragMove = (event: PointerEvent) => {
      const moveStart = performance.now();
      lastEvent = event;

      dragLastPos = Point.from(
        this.host._gfx.viewport.toModelCoordFromClientCoord([event.x, event.y]),
      );

      const moveContext: ExtensionDragMoveContext = {
        ...internal,
        event,
        dragLastPos,
        dx: dragLastPos.x - internal.dragStartPos.x,
        dy: dragLastPos.y - internal.dragStartPos.y,
      };

      // If shift key is pressed, restrict the movement to one direction
      if (this.host.keyboard.shiftKey$.peek()) {
        const angle = Math.abs(Math.atan2(moveContext.dy, moveContext.dx));
        const direction =
          angle < Math.PI / 4 || angle > 3 * (Math.PI / 4) ? "dy" : "dx";

        moveContext[direction] = 0;
      }

      if (
        lastMoveDelta &&
        lastMoveDelta[0] === moveContext.dx &&
        lastMoveDelta[1] === moveContext.dy
      ) {
        return;
      }

      lastMoveDelta = [moveContext.dx, moveContext.dy];

      this.host._safeExecute(
        () => {
          activeExtensionHandlers.forEach((handler) =>
            handler?.onDragMove?.(moveContext),
          );
        },
        this._extensionDispatchContext(
          "extension.onDragMove",
          internal.elements,
          "extension handler threw during onDragMove",
        ),
      );

      internal.elements.forEach((element) => {
        const { view, originalBound } = element;

        view.onDragMove({
          currentBound: originalBound,
          dx: moveContext.dx,
          dy: moveContext.dy,
          elements: internal.elements,
        });
      });

      if (
        canCoalesceDragMove &&
        !shouldCoalesceDragMove &&
        performance.now() - moveStart > DRAG_MOVE_HEAVY_COST_MS
      ) {
        shouldCoalesceDragMove = true;
      }
    };

    const dragMoveCoalescer = createRafCoalescer<PointerEvent>(applyDragMove);

    const onDragMove = (event: PointerEvent) => {
      if (!shouldCoalesceDragMove) {
        applyDragMove(event);
        return;
      }

      dragMoveCoalescer.schedule(event);
    };
    const viewportWatcher = this.host._gfx.viewport.viewportMoved.subscribe(
      () => {
        onDragMove(lastEvent as PointerEvent);
      },
    );
    const finishDrag = (event: PointerEvent, cancelled: boolean) => {
      if (finished) return;
      finished = true;
      this.host._activeInteraction$.value = null;

      host.removeEventListener("pointermove", onDragMove, false);
      host.removeEventListener("pointerup", onDragEnd, false);
      host.removeEventListener("pointercancel", onDragCancel, false);
      document.removeEventListener("keydown", onDragKeydown, true);
      viewportWatcher.unsubscribe();
      if (cancelled) {
        dragMoveCoalescer.cancel();
      } else {
        dragMoveCoalescer.flush();
      }

      dragLastPos = Point.from(
        this.host._gfx.viewport.toModelCoordFromClientCoord([event.x, event.y]),
      );
      const endContext: ExtensionDragEndContext = {
        ...internal,
        cancelled,
        event,
        dragLastPos,
        dx: cancelled ? 0 : dragLastPos.x - internal.dragStartPos.x,
        dy: cancelled ? 0 : dragLastPos.y - internal.dragStartPos.y,
      };

      if (cancelled) {
        internal.elements.forEach(({ model, originalBound }) => {
          model.xywh = originalBound.serialize();
        });
      }

      this.host._safeExecute(
        () => {
          activeExtensionHandlers.forEach((handler) =>
            handler?.onDragEnd?.(endContext),
          );
        },
        this._extensionDispatchContext(
          "extension.onDragEnd",
          internal.elements,
          "extension handler threw during onDragEnd",
        ),
      );

      this.host._std.store.transact(() => {
        internal.elements.forEach((element) => {
          const { view, originalBound } = element;

          if (cancelled) view.model.xywh = originalBound.serialize();

          view.onDragEnd({
            cancelled,
            currentBound: originalBound.moveDelta(endContext.dx, endContext.dy),
            dx: endContext.dx,
            dy: endContext.dy,
            elements: internal.elements,
          });
        });
      });

      this.host._safeExecute(
        () => {
          activeExtensionHandlers.forEach((handler) => handler?.clear?.());
        },
        this._extensionDispatchContext(
          "extension.clear",
          internal.elements,
          "extension handler threw during clear",
        ),
      );

      options.onDragEnd?.();
    };
    const onDragEnd = (event: PointerEvent) => finishDrag(event, false);
    const onDragCancel = (event: PointerEvent) => finishDrag(event, true);
    const onDragKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finishDrag(lastEvent as PointerEvent, true);
    };
    const listenEvent = () => {
      host.addEventListener("pointermove", onDragMove, false);
      host.addEventListener("pointerup", onDragEnd, false);
      host.addEventListener("pointercancel", onDragCancel, false);
      document.addEventListener("keydown", onDragKeydown, true);
    };
    const dragStart = () => {
      this.host._activeInteraction$.value = {
        type: "move",
        elements: context.elements,
      };

      internal.elements.forEach(({ view, originalBound }) => {
        view.onDragStart({
          currentBound: originalBound,
          elements: internal.elements,
        });
      });

      const dragStartContext: ExtensionDragStartContext = {
        ...internal,
        event: event as PointerEvent,
        dragLastPos,
      };

      this.host._safeExecute(
        () => {
          activeExtensionHandlers.forEach((handler) =>
            handler?.onDragStart?.(dragStartContext),
          );
        },
        this._extensionDispatchContext(
          "extension.onDragStart",
          internal.elements,
          "extension handler threw during onDragStart",
        ),
      );
    };

    listenEvent();
    dragStart();
  }

  /**
   * Build a `SafeExecuteContext` for the four
   * extension-hook dispatch sites inside
   * `handleElementMove` (P-VIRG-ARCH-H-02).
   *
   * `flavours` is de-duplicated; the formatter caps
   * the rendered list to 5 entries. `mode` is read
   * via `this.host._currentMode` (P-VIRG-ARCH-H-02
   * Slice 2), which delegates to the host-injected
   * `DocModeProvider` resolver on the `GfxController`.
   *
   * The lookup is cheap (one signal read) and is
   * intentionally NOT cached on the `SafeExecuteContext`
   * — the mode may have changed between
   * `_safeExecute` calls, and we want each log line
   * to reflect the mode that was current when the
   * handler crashed.
   */
  private _extensionDispatchContext(
    operation: string,
    elements: ReadonlyArray<{ model: GfxModel }>,
    errorMessage: string,
  ): SafeExecuteContext {
    const flavourSet = new Set<string>();
    for (const { model } of elements) {
      const flavour = "type" in model ? model.type : model.flavour;
      flavourSet.add(flavour);
    }
    return {
      operation,
      mode: this.host._currentMode,
      elementCount: elements.length,
      flavours: Array.from(flavourSet),
      errorMessage,
    };
  }
}
