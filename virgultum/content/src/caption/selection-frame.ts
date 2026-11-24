// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect } from "@preact/signals-core";
import type { BlockComponent } from "@virgultum/core/runtime";
import type {} from "@virgultum/core/view/block-selection";
import type {} from "@virgultum/core/view/block-zero-width";

/** Geometry shared by registered blocks that participate in document selection. */
export function selectionFrame(
  block: BlockComponent,
  content: HTMLElement,
  trailingInsertion = false,
) {
  const doc = block.ownerDocument;
  const frame = doc.createElement("div");
  frame.className = "myoxus-block-component";
  frame.style.position = "relative";
  const selection = doc.createElement("myoxus-block-selection");
  frame.append(content, selection);
  block.disposables.add(
    effect(() => {
      selection.selected = block.selected$.value;
    }),
  );
  if (trailingInsertion) {
    const insertion = doc.createElement("block-zero-width");
    insertion.block = block;
    block.disposables.add(
      effect(() => {
        if (block.store.readonly) insertion.remove();
        else frame.append(insertion);
      }),
    );
  }
  return frame;
}
