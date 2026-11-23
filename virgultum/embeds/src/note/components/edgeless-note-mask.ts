import { almostEqual, Bound } from "@virgultum/core/primitives/gfx";
import type { NoteBlockModel } from "@virgultum/core/models";

import { ACTIVE_NOTE_EXTRA_PADDING } from "../note-edgeless-block.styles";

export function trackCanvasNoteBounds(
  mask: HTMLElement,
  model: NoteBlockModel,
  isEditing: () => boolean,
) {
  let frame = 0;
  let measuredHeight = 0;
  const container = mask.closest<HTMLElement>(
    ".virgultum-note-edgeless-container",
  );
  const noteView = mask.closest<HTMLElement>("myoxus-edgeless-note");
  const updateBounds = () => {
    frame = 0;
    if (
      !mask.isConnected ||
      model.store.readonly ||
      model.props.edgeless.collapse
    )
      return;
    const bound = Bound.deserialize(model.xywh);
    const scale = model.props.edgeless.scale ?? 1;
    const height = measuredHeight * scale;
    const width =
      container && noteView && container.offsetWidth > noteView.offsetWidth
        ? Math.max(bound.w, container.offsetWidth * scale)
        : bound.w;
    if (
      !height ||
      !width ||
      (almostEqual(bound.h, height) && almostEqual(bound.w, width))
    )
      return;
    // Canvas selection and hit testing must include the full rendered table.
    bound.h = height;
    bound.w = width;
    model.stash("xywh");
    model.xywh = bound.serialize();
    model.pop("xywh");
  };
  const observer = new ResizeObserver((entries) => {
    const entry = entries.at(-1);
    if (!entry) return;
    // The mask grows around an editing note. Its interaction-only padding
    // must not enter persisted geometry or focus/mode changes resize content.
    const extra = isEditing() ? 2 * ACTIVE_NOTE_EXTRA_PADDING : 0;
    measuredHeight = Math.max(0, entry.contentRect.height - extra);
    // Updating the observed Note's geometry during delivery feeds its own
    // ancestor layout back into ResizeObserver. Coalesce the latest measure
    // into the next frame and recheck live readonly/collapse state there.
    if (!frame) frame = requestAnimationFrame(updateBounds);
  });

  observer.observe(mask);
  // Layout can settle while the store is readonly. Permission changes do
  // not resize the mask, so replay its last measurement when writes resume.
  const readonlySubscription = model.store.readonly$.subscribe((readonly) => {
    if (!readonly && measuredHeight && !frame)
      frame = requestAnimationFrame(updateBounds);
  });

  return () => {
    observer.disconnect();
    readonlySubscription();
    cancelAnimationFrame(frame);
  };
}

export function frameTitleAtPoint(root: HTMLElement, event: MouseEvent) {
  const titleAtPoint = (title?: HTMLElement | null) => {
    if (!title) return null;
    const rect = title.getBoundingClientRect();
    return event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
      ? title
      : null;
  };
  for (const element of root.querySelectorAll<HTMLElement>(
    "myoxus-frame-title",
  )) {
    const title = titleAtPoint(element);
    if (title) return title;
  }
  return null;
}
