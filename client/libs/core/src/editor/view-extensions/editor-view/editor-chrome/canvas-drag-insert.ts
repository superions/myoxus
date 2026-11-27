// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Bound } from "@virgultum/editor/global/gfx";
import { ViewportElementProvider } from "@virgultum/editor/shared/services";
import type { BlockComponent } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";

export type CanvasDragPreview =
  | Readonly<{ kind: "svg"; markup: string }>
  | Readonly<{ kind: "image"; src: string }>
  | Readonly<{ kind: "text"; label: string }>;

export interface CanvasDragInsertOptions<T> {
  edgeless: BlockComponent;
  data: T;
  sourceElement: HTMLElement;
  preview: CanvasDragPreview;
  /** Target width on the canvas in model coordinates before zoom scaling. */
  standardWidth?: number;
  /** Optional stroke/fill styling applied to SVG drag previews (used by Shapes). */
  previewStyle?: Readonly<{ color?: string; stroke?: string }>;
  /** Initial client coordinates from the mousedown or touchstart event. */
  startClientX: number;
  startClientY: number;
  /** Minimum pointer travel in CSS pixels before entering drag mode. */
  dragThreshold?: number;
  onDragStart?: () => void;
  onClick?: (data: T) => void;
  onDrop: (data: T, bound: Bound) => void;
  onCancel?: () => void;
}

function buildPreviewElement(
  doc: Document,
  preview: CanvasDragPreview,
  width: number,
  height: number,
  previewStyle?: Readonly<{ color?: string; stroke?: string }>,
): HTMLElement {
  const container = doc.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${Math.max(width, 24)}px`,
    height: `${Math.max(height, 24)}px`,
    pointerEvents: "none",
    zIndex: "var(--myoxus-z-index-popover, 10000)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    opacity: "0.9",
    transformOrigin: "center center",
    willChange: "transform",
  });
  if (previewStyle?.color) container.style.color = previewStyle.color;
  if (previewStyle?.stroke)
    container.style.setProperty("stroke", previewStyle.stroke);

  if (preview.kind === "svg") {
    container.innerHTML = preview.markup;
    const svg = container.querySelector("svg");
    if (svg) {
      svg.style.display = "block";
      svg.style.width = "100%";
      svg.style.height = "100%";
    }
  } else if (preview.kind === "image") {
    const img = doc.createElement("img");
    img.src = preview.src;
    Object.assign(img.style, {
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: "contain",
    });
    container.append(img);
  } else {
    container.textContent = preview.label;
  }

  return container;
}

/**
 * Shared AGPL pointer drag-to-canvas controller for dock palettes (Templates
 * and Shapes). Distinguishes a click (travel < threshold) from a canvas drag,
 * renders a lightweight viewport-scoped preview while dragging, and converts
 * drop coordinates into a model-space `Bound`.
 *
 * Returns a cleanup disposer that cancels an in-flight drag if the owning
 * component unmounts.
 */
export function startCanvasDragInsert<T>(
  options: CanvasDragInsertOptions<T>,
): () => void {
  const {
    edgeless,
    data,
    sourceElement,
    preview,
    standardWidth = 100,
    previewStyle,
    startClientX,
    startClientY,
    dragThreshold = 5,
    onDragStart,
    onClick,
    onDrop,
    onCancel,
  } = options;

  const doc = sourceElement.ownerDocument;
  const win = doc.defaultView ?? window;
  const gfx = edgeless.std.get(GfxControllerIdentifier);
  const { viewportElement } = edgeless.std.get(ViewportElementProvider);
  const sourceRect = sourceElement.getBoundingClientRect();
  const aspectRatio =
    sourceRect.width > 0 && sourceRect.height > 0
      ? sourceRect.height / sourceRect.width
      : 1;

  let dragging = false;
  let finished = false;
  let overlayEl: HTMLElement | null = null;
  let lastX = startClientX;
  let lastY = startClientY;

  const modelWidth = standardWidth;
  const modelHeight = Math.max(24, Math.round(modelWidth * aspectRatio));

  const positionOverlay = (clientX: number, clientY: number) => {
    if (!overlayEl) return;
    const zoom = gfx.viewport.zoom;
    const renderW = Math.max(32, Math.min(modelWidth * zoom, 360));
    const renderH = Math.max(32, Math.min(modelHeight * zoom, 360));
    overlayEl.style.width = `${renderW}px`;
    overlayEl.style.height = `${renderH}px`;
    overlayEl.style.transform = `translate3d(${clientX - renderW / 2}px, ${clientY - renderH / 2}px, 0)`;
  };

  const cleanup = () => {
    win.removeEventListener("mousemove", handleMouseMove, true);
    win.removeEventListener("mouseup", handleMouseUp, true);
    win.removeEventListener("touchmove", handleTouchMove, true);
    win.removeEventListener("touchend", handleTouchEnd, true);
    win.removeEventListener("touchcancel", handleCancel, true);
    win.removeEventListener("keydown", handleKeyDown, true);
    overlayEl?.remove();
    overlayEl = null;
  };

  const beginDrag = (clientX: number, clientY: number) => {
    dragging = true;
    const zoom = gfx.viewport.zoom;
    const renderW = Math.max(32, Math.min(modelWidth * zoom, 360));
    const renderH = Math.max(32, Math.min(modelHeight * zoom, 360));
    overlayEl = buildPreviewElement(
      doc,
      preview,
      renderW,
      renderH,
      previewStyle,
    );
    viewportElement.append(overlayEl);
    positionOverlay(clientX, clientY);
    onDragStart?.();
  };

  const handleMove = (clientX: number, clientY: number) => {
    if (finished) return;
    lastX = clientX;
    lastY = clientY;
    if (!dragging) {
      const dx = clientX - startClientX;
      const dy = clientY - startClientY;
      if (Math.hypot(dx, dy) < dragThreshold) return;
      beginDrag(clientX, clientY);
      return;
    }
    positionOverlay(clientX, clientY);
  };

  const finishAt = (clientX: number, clientY: number) => {
    if (finished) return;
    finished = true;
    cleanup();

    if (!dragging) {
      onClick?.(data);
      return;
    }

    const viewportRect = viewportElement.getBoundingClientRect();
    const insideViewport =
      clientX >= viewportRect.left &&
      clientX <= viewportRect.right &&
      clientY >= viewportRect.top &&
      clientY <= viewportRect.bottom;
    if (!insideViewport) {
      onCancel?.();
      return;
    }

    const [modelX, modelY] = gfx.viewport.toModelCoord(
      clientX - viewportRect.left,
      clientY - viewportRect.top,
    );
    const bound = new Bound(
      modelX - modelWidth / 2,
      modelY - modelHeight / 2,
      modelWidth,
      modelHeight,
    );
    onDrop(data, bound);
  };

  const handleCancel = () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (dragging) onCancel?.();
  };

  const handleMouseMove = (event: MouseEvent) => {
    handleMove(event.clientX, event.clientY);
  };
  const handleMouseUp = (event: MouseEvent) => {
    finishAt(event.clientX, event.clientY);
  };
  const handleTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) handleMove(touch.clientX, touch.clientY);
  };
  const handleTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    finishAt(touch?.clientX ?? lastX, touch?.clientY ?? lastY);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
    }
  };

  win.addEventListener("mousemove", handleMouseMove, true);
  win.addEventListener("mouseup", handleMouseUp, true);
  win.addEventListener("touchmove", handleTouchMove, true);
  win.addEventListener("touchend", handleTouchEnd, true);
  win.addEventListener("touchcancel", handleCancel, true);
  win.addEventListener("keydown", handleKeyDown, true);

  return () => {
    if (finished) return;
    finished = true;
    cleanup();
  };
}
