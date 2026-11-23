// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EditorHost } from "@virgultum/editor/std";
import type { GfxController } from "@virgultum/editor/std/gfx";

/** The same Store remains in use. Wait until the old scope has no live input to transfer. */
export function watchCanvasHandoff(
  host: EditorHost,
  gfx: GfxController,
  acceptsCanvas: () => boolean,
  transfer: () => void,
) {
  const abort = new AbortController();
  const pointers = new Set<number>();
  let composing = false;
  let pending = false;
  let queued = false;
  const opts = { capture: true, signal: abort.signal };

  const check = () => {
    if (!pending || queued || abort.signal.aborted) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (
        abort.signal.aborted ||
        pointers.size ||
        composing ||
        gfx.selection.editing ||
        gfx.tool.dragging$.peek()
      )
        return;
      pending = !acceptsCanvas();
      if (!pending) return;
      dispose();
      transfer();
    });
  };

  const request = () => {
    pending = true;
    check();
  };

  const blocks = host.store.slots.blockUpdated.subscribe((event) => {
    if (event.type !== "update") request();
  });
  const readonly = host.store.readonly$.subscribe((locked) => {
    if (locked) request();
  });
  const selection = gfx.selection.slots.updated.subscribe(check);
  const stopDrag = gfx.tool.dragging$.subscribe(check);
  const dispose = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    blocks.unsubscribe();
    readonly();
    selection.unsubscribe();
    stopDrag();
  };

  host.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    opts,
  );
  host.addEventListener(
    "compositionend",
    () => {
      composing = false;
      check();
    },
    opts,
  );
  host.addEventListener(
    "pointerdown",
    (event) => pointers.add(event.pointerId),
    opts,
  );
  const finishPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    check();
  };
  host.ownerDocument.addEventListener("pointerup", finishPointer, opts);
  host.ownerDocument.addEventListener("pointercancel", finishPointer, opts);
  host.ownerDocument.defaultView?.addEventListener(
    "blur",
    () => {
      pointers.clear();
      check();
    },
    opts,
  );
  return dispose;
}
