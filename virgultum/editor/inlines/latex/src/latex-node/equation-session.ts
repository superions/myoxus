// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { LatexSourceEditor } from "./latex-source-editor";
import type { Signal } from "@preact/signals-core";
import {
  EditorChromeHostIdentifier,
  mountInlinePopup,
} from "@virgultum/shared/services";
import {
  TextSelection,
  type BlockComponent,
  type BlockStdScope,
} from "@virgultum/std";

/** The source renderer keeps Y.Text/IME; this session owns only the anchored chrome. */
export function openEquationEditor(
  std: BlockStdScope,
  target: HTMLElement,
  source: Signal<string>,
  abort: AbortController,
  position: "bottom" | "bottom-start" = "bottom-start",
  change = (value: string) => {
    source.value = value;
  },
) {
  const chrome = std.getOptional(EditorChromeHostIdentifier);
  const block = target.closest<BlockComponent>("[data-block-id]");
  const valid = () =>
    target.isConnected &&
    std.host.isConnected &&
    !std.store.readonly &&
    !!block &&
    std.store.getBlock(block.model.id)?.model === block.model;
  if (!chrome || !valid()) return abort.abort();
  const editor = new LatexSourceEditor();
  editor.std = std;
  editor.latexSignal = source;
  editor.change = change;
  editor.canEdit = () => !abort.signal.aborted && valid();
  const restoreFocus = () => {
    if (std.host.isConnected && !std.store.readonly) {
      std.event.active = true;
      // Popup inputs exclude range synchronization; replay the committed selection on close.
      const selection = std.selection.find(TextSelection);
      if (selection) std.range.syncTextSelectionToRange(selection);
      else std.host.focus({ preventScroll: true });
    }
  };
  mountInlinePopup(
    std,
    () => (valid() ? target : null),
    (controls) =>
      chrome.renderEquation({
        ...controls,
        position,
        restoreFocus,
        syncSourceRange: () => {
          const input = editor.richText?.inlineEditor;
          const range = input?.getNativeRange();
          if (range) input?.setInlineRange(input.toInlineRange(range));
        },
        mountSource: (container) => {
          if (container && !abort.signal.aborted) container.append(editor);
          else editor.remove();
        },
      }),
    abort,
    restoreFocus,
  );
}
