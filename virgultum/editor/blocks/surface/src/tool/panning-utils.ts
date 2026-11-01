import type { IVec } from "@virgultum/global/gfx";
import type { PointerEventState } from "@virgultum/std";
import type { Viewport } from "@virgultum/std/gfx";

const PANNING_DISTANCE = 30;

export function calPanDeltaFromClientPoint({
  clientX,
  clientY,
  edgeDistance = 20,
  height,
  left,
  maxDelta = PANNING_DISTANCE,
  top,
  width,
}: {
  clientX: number;
  clientY: number;
  edgeDistance?: number;
  height: number;
  left: number;
  maxDelta?: number;
  top: number;
  width: number;
}): IVec | null {
  const nearLeft = clientX < left + edgeDistance;
  const nearRight = clientX > left + width - edgeDistance;
  const nearTop = clientY < top + edgeDistance;
  const nearBottom = clientY > top + height - edgeDistance;
  if (!(nearLeft || nearRight || nearTop || nearBottom)) return null;
  const panLimit = Number.isFinite(maxDelta)
    ? Math.max(0, maxDelta)
    : PANNING_DISTANCE;

  let deltaX = 0;
  let deltaY = 0;
  if (nearLeft) {
    deltaX = Math.max(-panLimit, clientX - (left + edgeDistance));
  } else if (nearRight) {
    deltaX = Math.min(panLimit, clientX - (left + width - edgeDistance));
  }

  if (nearTop) {
    deltaY = Math.max(-panLimit, clientY - (top + edgeDistance));
  } else if (nearBottom) {
    deltaY = Math.min(panLimit, clientY - (top + height - edgeDistance));
  }

  return [deltaX, deltaY];
}

export function calPanDelta(
  viewport: Viewport,
  e: PointerEventState,
  edgeDistance = 20,
): IVec | null {
  // Get viewport edge
  const { left, top } = viewport;
  const { width, height } = viewport;
  // Get pointer position
  let { x, y } = e;
  const { containerOffset } = e;
  x += containerOffset.x;
  y += containerOffset.y;
  return calPanDeltaFromClientPoint({
    clientX: x,
    clientY: y,
    edgeDistance,
    height,
    left,
    top,
    width,
  });
}
