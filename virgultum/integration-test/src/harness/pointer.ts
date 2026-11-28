// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

export interface RelativePoint {
  x: number;
  y: number;
}

const DESKTOP_MOUSE_POINTER: PointerEventInit = {
  bubbles: true,
  isPrimary: true,
  pointerId: 1,
  pointerType: "mouse",
};

/** Wait one animation frame plus an optional delay in milliseconds. */
export function flushFrame(delayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, delayMs);
    });
  });
}

function toClientCoords(target: HTMLElement, pos: RelativePoint) {
  const rect = target.getBoundingClientRect();
  return { clientX: rect.x + pos.x, clientY: rect.y + pos.y };
}

/** Dispatch a desktop primary-pointer click sequence relative to `target`. */
export function dispatchClick(
  target: HTMLElement,
  position: RelativePoint,
): void {
  const coords = toClientCoords(target, position);
  target.dispatchEvent(
    new PointerEvent("pointerdown", { ...DESKTOP_MOUSE_POINTER, ...coords }),
  );
  target.dispatchEvent(
    new PointerEvent("pointerup", { ...DESKTOP_MOUSE_POINTER, ...coords }),
  );
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, ...coords }));
}

/** Dispatch a desktop mouse drag sequence from `start` to `end` relative to `target`. */
export function dispatchDrag(
  target: HTMLElement,
  start: RelativePoint,
  end: RelativePoint,
  steps = 5,
): void {
  const startCoords = toClientCoords(target, start);
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      ...DESKTOP_MOUSE_POINTER,
      ...startCoords,
    }),
  );
  target.dispatchEvent(
    new PointerEvent("pointermove", {
      ...DESKTOP_MOUSE_POINTER,
      ...startCoords,
    }),
  );

  if (steps > 0) {
    const dx = (end.x - start.x) / steps;
    const dy = (end.y - start.y) / steps;
    for (let step = 1; step <= steps; step += 1) {
      const coords = toClientCoords(target, {
        x: start.x + dx * step,
        y: start.y + dy * step,
      });
      target.dispatchEvent(
        new PointerEvent("pointermove", {
          ...DESKTOP_MOUSE_POINTER,
          ...coords,
        }),
      );
    }
  }

  const endCoords = toClientCoords(target, end);
  target.dispatchEvent(
    new PointerEvent("pointermove", { ...DESKTOP_MOUSE_POINTER, ...endCoords }),
  );
  target.dispatchEvent(
    new PointerEvent("pointerup", { ...DESKTOP_MOUSE_POINTER, ...endCoords }),
  );
}
