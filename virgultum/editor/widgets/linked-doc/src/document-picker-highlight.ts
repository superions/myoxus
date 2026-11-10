// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { LinkedDocContext } from "./config";

let nextHighlight = 0;

/** Native range paint follows wrapped text, scrolling and zoom without overlay rectangles. */
export function highlightDocumentQuery({
  inlineEditor,
  startRange,
  triggerKey,
  std,
}: LinkedDocContext) {
  if (typeof Highlight === "undefined" || !CSS.highlights) return () => {};
  const name = `myoxus-document-picker-${++nextHighlight}`;
  const highlight = new Highlight();
  const style = std.host.ownerDocument.createElement("style");
  style.textContent = `::highlight(${name}) { background-color: var(--myoxus-hover-color); }`;
  std.host.ownerDocument.head.append(style);
  CSS.highlights.set(name, highlight);
  let disposed = false;
  const update = () => {
    if (disposed) return;
    highlight.clear();
    const current = inlineEditor.getInlineRange();
    const index = startRange.index - triggerKey.length;
    if (!current || current.index < startRange.index) return;
    const range = inlineEditor.toDomRange({
      index,
      length: current.index - index,
    });
    if (range) highlight.add(range);
  };
  const subscription = inlineEditor.slots.renderComplete.subscribe(() =>
    queueMicrotask(update),
  );
  update();
  return () => {
    disposed = true;
    subscription.unsubscribe();
    CSS.highlights.delete(name);
    style.remove();
  };
}
