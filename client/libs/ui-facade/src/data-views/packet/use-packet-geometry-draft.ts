// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PacketBitGridProps, PacketGeometryIntent } from "./types";
function rectDistance(bounds: DOMRect, x: number, y: number) {
  return Math.hypot(
    Math.max(bounds.left - x, 0, x - bounds.right),
    Math.max(bounds.top - y, 0, y - bounds.bottom),
  );
}

/** Visible Row bounds include canvas zoom and current scroll exactly once. */
function packetBitAt(
  root: HTMLElement | null,
  bitsPerRow: number,
  x: number,
  y: number,
) {
  const rows = [
    ...(root?.querySelectorAll<HTMLElement>("[data-packet-row]") ?? []),
  ];
  const row = rows.reduce<HTMLElement | undefined>((best, candidate) => {
    const bounds = candidate.getBoundingClientRect();
    const previous = best?.getBoundingClientRect();
    const distance = (rect: DOMRect) =>
      Math.max(rect.top - y, 0, y - rect.bottom);
    return !previous || distance(bounds) < distance(previous)
      ? candidate
      : best;
  }, undefined);
  if (!row) return 0;
  const bounds = row.getBoundingClientRect();
  return (
    Number(row.dataset.packetRow) * bitsPerRow +
    Math.round((x - bounds.left) / (bounds.width / bitsPerRow))
  );
}

function packetIntentAt(
  root: HTMLElement | null,
  order: readonly string[],
  bitsPerRow: number,
  intent: PacketGeometryIntent,
  offset: number,
  x: number,
  y: number,
): PacketGeometryIntent {
  if (intent.kind === "boundary")
    return { ...intent, bit: packetBitAt(root, bitsPerRow, x, y) + offset };
  const fragments = [
    ...(root?.querySelectorAll<HTMLElement>("[data-packet-field-id]") ?? []),
  ];
  const hit = fragments.reduce<HTMLElement | undefined>(
    (best, candidate) =>
      !best ||
      rectDistance(candidate.getBoundingClientRect(), x, y) <
        rectDistance(best.getBoundingClientRect(), x, y)
        ? candidate
        : best,
    undefined,
  );
  const targetIndex = hit ? order.indexOf(hit.dataset.packetFieldId!) : -1;
  return targetIndex < 0 ? intent : { ...intent, targetIndex };
}

/** Edge scrolling stays inside the declared workarea owner. Like Journey,
 * its activation zone and speed derive from that scrollport's geometry. */
function scrollPacketEdge(viewport: HTMLElement | null, x: number, y: number) {
  if (!viewport) return false;
  const bounds = viewport.getBoundingClientRect();
  const direction = (point: number, start: number, end: number) =>
    point < start || point > end
      ? 0
      : point < start + (end - start) * 0.1
        ? -1
        : point > end - (end - start) * 0.1
          ? 1
          : 0;
  const left =
    direction(x, bounds.left, bounds.right) *
    Math.max(4, viewport.clientWidth * 0.015);
  const top =
    direction(y, bounds.top, bounds.bottom) *
    Math.max(4, viewport.clientHeight * 0.015);
  const beforeLeft = viewport.scrollLeft,
    beforeTop = viewport.scrollTop;
  viewport.scrollBy({ left, top, behavior: "instant" });
  return beforeLeft !== viewport.scrollLeft || beforeTop !== viewport.scrollTop;
}

const DRAG_THRESHOLD = 4; // Matches the existing Gantt geometry gesture threshold in screen pixels.
type PointerDraft = {
  id: number;
  owner: HTMLElement;
  x: number;
  y: number;
  offset: number;
  pointerX: number;
  pointerY: number;
  moved: boolean;
  intent: PacketGeometryIntent;
};
export function usePacketGeometryDraft(props: PacketBitGridProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const keyboardOwner = useRef<HTMLElement | undefined>(undefined);
  const active = useRef<PointerDraft | undefined>(undefined);
  const [intent, setIntent] = useState<PacketGeometryIntent>();
  const latest = useRef(props);
  latest.current = props;
  const stopScroll = () => {
    if (scrollFrame.current !== undefined)
      cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = undefined;
  };
  const clear = (cancel = true, escape?: KeyboardEvent) => {
    stopScroll();
    keyboardOwner.current = undefined;
    const draft = active.current;
    active.current = undefined;
    setIntent(undefined);
    if (cancel && (draft || intent)) latest.current.onGeometryCancel?.(escape);
    if (draft?.owner.hasPointerCapture(draft.id))
      draft.owner.releasePointerCapture(draft.id);
  };
  useEffect(() => {
    if (props.readonly || props.displayOnly) clear();
  }, [props.readonly, props.displayOnly]);
  useEffect(() => {
    clear();
  }, [props.gestureSession]);
  useEffect(
    () => () => {
      stopScroll();
      const draft = active.current;
      active.current = undefined;
      if (draft?.owner.hasPointerCapture(draft.id))
        draft.owner.releasePointerCapture(draft.id);
      latest.current.onGeometryCancel?.();
    },
    [],
  );
  useLayoutEffect(() => {
    if (!intent || !keyboardOwner.current) return;
    const candidates = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>(
        intent.kind === "reorder"
          ? "[data-packet-field-id]"
          : "[data-packet-boundary-left]",
      ) ?? []),
    ];
    const target = candidates.find((element) =>
      intent.kind === "reorder"
        ? element.dataset.packetFieldId === intent.fieldKey
        : element.dataset.packetBoundaryLeft === intent.leftKey,
    );
    if (!target) return;
    // Row previews may replace the focused fragment. Session identity, not its
    // old DOM node, restores the original keyboard control before the next key.
    if (
      target !== keyboardOwner.current ||
      document.activeElement === keyboardOwner.current
    ) {
      keyboardOwner.current = target;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [props.rows, intent]);
  const bitAt = (x: number, y: number) =>
    packetBitAt(rootRef.current, latest.current.bitsPerRow, x, y);
  const preview = (next: PacketGeometryIntent) => {
    setIntent(next);
    latest.current.onGeometryPreview?.(next);
  };
  const updatePointer = (draft: PointerDraft) => {
    const next = packetIntentAt(
      rootRef.current,
      latest.current.fieldOrder,
      latest.current.bitsPerRow,
      draft.intent,
      draft.offset,
      draft.pointerX,
      draft.pointerY,
    );
    draft.intent = next;
    preview(next);
  };
  const tickScroll = () => {
    scrollFrame.current = undefined;
    const draft = active.current;
    if (
      !draft?.moved ||
      !scrollPacketEdge(viewportRef.current, draft.pointerX, draft.pointerY)
    )
      return;
    updatePointer(draft);
    scrollFrame.current = requestAnimationFrame(tickScroll);
  };
  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    next: PacketGeometryIntent,
  ) => {
    if (
      props.readonly ||
      props.displayOnly ||
      event.button !== 0 ||
      !event.isPrimary
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    clear();
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = {
      id: event.pointerId,
      owner: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      pointerX: event.clientX,
      pointerY: event.clientY,
      offset:
        next.kind === "boundary"
          ? next.bit - bitAt(event.clientX, event.clientY)
          : 0,
      intent: next,
    };
    latest.current.onGeometryStart?.(next);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const draft = active.current;
    if (!draft || draft.id !== event.pointerId) return;
    event.stopPropagation();
    if (
      !draft.moved &&
      Math.hypot(event.clientX - draft.x, event.clientY - draft.y) <
        DRAG_THRESHOLD
    )
      return;
    if (!draft.moved) {
      // Transfer capture only after the click threshold. The stable grid survives
      // cross-Row previews; ordinary clicks/double-clicks retain their field target.
      const owner = rootRef.current;
      if (owner) {
        draft.owner = owner;
        owner.setPointerCapture(draft.id);
        owner.focus({ preventScroll: true });
      }
    }
    draft.moved = true;
    draft.pointerX = event.clientX;
    draft.pointerY = event.clientY;
    updatePointer(draft);
    if (scrollFrame.current === undefined)
      scrollFrame.current = requestAnimationFrame(tickScroll);
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    const draft = active.current;
    if (!draft || draft.id !== event.pointerId) return;
    event.stopPropagation();
    const next = draft.intent,
      changed = draft.moved;
    clear(false);
    if (changed) latest.current.onGeometryConfirm?.(next);
    else latest.current.onGeometryCancel?.();
  };
  const keyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    initial: PacketGeometryIntent,
  ) => {
    if (props.readonly || props.displayOnly) return;
    const current = intent ?? initial;
    if (event.key === "Escape" && intent) {
      event.preventDefault();
      event.stopPropagation();
      clear(true, event.nativeEvent);
      return;
    }
    if (
      intent &&
      (event.key === "Enter" ||
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight") &&
      keyboardOwner.current !== event.currentTarget
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && intent) {
      event.preventDefault();
      event.stopPropagation();
      const next = intent;
      clear(false);
      latest.current.onGeometryConfirm?.(next);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (current.kind === "reorder" && !event.altKey) {
      if (intent) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!intent) {
      keyboardOwner.current = event.currentTarget;
      latest.current.onGeometryStart?.(initial);
    }
    const delta =
      (event.key === "ArrowLeft" ? -1 : 1) *
      (current.kind === "boundary" && event.shiftKey ? 8 : 1);
    preview(
      current.kind === "boundary"
        ? { ...current, bit: current.bit + delta }
        : { ...current, targetIndex: current.targetIndex + delta },
    );
  };
  return {
    rootRef,
    viewportRef,
    intent,
    begin,
    move,
    finish,
    cancel: (escape?: KeyboardEvent) => clear(true, escape),
    keyboard,
    pointerCancel: () => clear(),
    lostCapture: (event: ReactPointerEvent<HTMLElement>) => {
      if (active.current?.owner === event.target) clear();
    },
  };
}
