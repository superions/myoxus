// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { autoUpdate, type ReferenceElement } from "@floating-ui/dom";
import type { BlockStdScope } from "@virgultum/std";
import { render, nothing, type TemplateResult } from "lit";
import type { EditorInlinePopupControls } from "./editor-chrome-host";

const activePopups = new WeakMap<Document, AbortController>();

/** Mount in the existing React tree; range/block anchors retain renderer geometry. */
export function mountInlinePopup(
  std: BlockStdScope,
  getTarget: () => Range | ReferenceElement | null,
  view: (controls: EditorInlinePopupControls) => TemplateResult,
  abort: AbortController,
  restoreFocus: () => void,
) {
  const initialTarget = getTarget();
  if (abort.signal.aborted || !initialTarget) return;
  const doc = std.host.ownerDocument;
  activePopups.get(doc)?.abort();
  activePopups.set(doc, abort);
  const root = doc.createElement("div");
  root.setAttribute("data-range-sync-exclude", "true");
  doc.body.append(root);
  // Native range highlighting keeps the edited text visible while a form owns focus.
  // This is document-selection paint, not popup chrome.
  const rangeHighlight =
    initialTarget instanceof Range && typeof Highlight !== "undefined"
      ? new Highlight()
      : null;
  const highlightStyle = doc.createElement("style");
  highlightStyle.textContent =
    "::highlight(myoxus-inline-popup) { background-color: color-mix(in srgb, var(--myoxus-primary-color) 25%, transparent); }";
  if (rangeHighlight) {
    root.append(highlightStyle);
    CSS.highlights.set("myoxus-inline-popup", rangeHighlight);
  }
  let stopPositioning: (() => void) | undefined;
  const observer = new MutationObserver(() => {
    if (!std.host.isConnected) abort.abort();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  abort.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      stopPositioning?.();
      render(nothing, root);
      root.remove();
      if (rangeHighlight) CSS.highlights.delete("myoxus-inline-popup");
      activePopups.delete(doc);
      // The native focus trap must unmount before the editor can regain focus.
      requestAnimationFrame(() => {
        if (!activePopups.has(doc)) restoreFocus();
      });
    },
    { once: true },
  );
  render(
    view({
      close: () => abort.abort(),
      setAnchor: (anchor) => {
        stopPositioning?.();
        if (!anchor || abort.signal.aborted) return;
        const reference = {
          contextElement: std.host,
          getBoundingClientRect: () =>
            getTarget()?.getBoundingClientRect() ?? new DOMRect(),
        };
        stopPositioning = autoUpdate(
          reference,
          anchor,
          () => {
            const target = getTarget();
            if (!target || !std.host.isConnected || std.store.readonly) {
              abort.abort();
              return;
            }
            const rect = target.getBoundingClientRect();
            rangeHighlight?.clear();
            if (target instanceof Range) rangeHighlight?.add(target);
            // Viewport coordinates also work when the edited text is inside a zoomed Note.
            Object.assign(anchor.style, {
              position: "fixed",
              pointerEvents: "none",
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            });
          },
          { animationFrame: true, elementResize: false },
        );
        if (abort.signal.aborted) stopPositioning();
      },
    }),
    root,
  );
}
