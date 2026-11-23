import {
  EdgelessLegacySlotIdentifier,
  OverlayIdentifier,
} from "@virgultum/canvas-runtime/surface";
import type { ConnectorElementModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import type { ConnectionOverlay } from "../connection-overlay";

export const CONNECTOR_HANDLE_SIZE = 20;
export const connectorHandleStyles = `
    .line-controller {
      position: absolute;
      width: ${CONNECTOR_HANDLE_SIZE}px;
      height: ${CONNECTOR_HANDLE_SIZE}px;
      box-sizing: border-box;
      border-radius: 50%;
      border: 2px solid var(--myoxus-text-emphasis-color);
      background-color: var(--myoxus-background-primary-color);
      cursor: pointer;
      z-index: 10;
      pointer-events: all;
      /**
       * Fix: pointerEvent stops firing after a short time.
       * When a gesture is started, the browser intersects the touch-action values of the touched element and its ancestors,
       * up to the one that implements the gesture (in other words, the first containing scrolling element)
       * https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
       */
      touch-action: none;
    }
`;

export function startConnectorReconnect(
  std: BlockStdScope,
  connector: ConnectorElementModel,
  endpoint: "source" | "target",
  handle: HTMLElement,
  event: PointerEvent,
) {
  event.stopPropagation();
  if (event.button !== 0 || std.store.readonly || connector.isLocked()) return;

  // A specialist can own this gesture as a local confirmation draft.
  if (
    !std.host.dispatchEvent(
      new CustomEvent("gfx-connector-reconnect-start", {
        cancelable: true,
        detail: { event, connector, endpoint },
      }),
    )
  )
    return;

  const { pointerId } = event;
  const gfx = std.get(GfxControllerIdentifier);
  const overlay = std.get(OverlayIdentifier("connection")) as ConnectionOverlay;
  const slots = std.get(EdgelessLegacySlotIdentifier);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const finish = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (handle.hasPointerCapture(pointerId))
      handle.releasePointerCapture(pointerId);
    overlay.clear();
    std.store.captureSync();
    slots.elementResizeEnd.next();
  };

  handle.setPointerCapture(pointerId);
  std.store.captureSync();
  slots.elementResizeStart.next();
  handle.addEventListener(
    "pointermove",
    (move) => {
      if (move.pointerId !== pointerId) return;
      if (std.store.readonly || connector.isLocked()) {
        finish();
        return;
      }
      const point = gfx.viewport.toModelCoordFromClientCoord([move.x, move.y]);
      const otherId = connector[endpoint === "source" ? "target" : "source"].id;
      connector[endpoint] = overlay.renderConnector(
        point,
        otherId ? [otherId] : [],
      );
    },
    options,
  );
  const finishPointer = (end: PointerEvent) => {
    if (end.pointerId === pointerId) finish();
  };
  handle.addEventListener("pointerup", finishPointer, options);
  handle.addEventListener("pointercancel", finishPointer, options);
  handle.addEventListener("lostpointercapture", finishPointer, options);
  return finish;
}
