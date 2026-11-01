// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EditorChromeHostIdentifier,
  mountInlinePopup,
} from "@virgultum/shared/services";
import type { MyoxusInlineEditor } from "@virgultum/shared/types";
import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";
import type { BlockStdScope } from "@virgultum/std";
import type { InlineRange } from "@virgultum/std/inline";

export function openLinkEditor(
  std: BlockStdScope,
  type: "create" | "edit",
  editor: MyoxusInlineEditor,
  range: InlineRange,
  abort: AbortController,
) {
  const host = std.getOptional(EditorChromeHostIdentifier);
  const originalLink = editor.getFormat(range).link;
  const originalText = editor.yTextString.slice(
    range.index,
    range.index + range.length,
  );
  const valid = () =>
    !std.store.readonly &&
    editor.rootElement?.isConnected &&
    editor.isValidInlineRange(range) &&
    editor.getFormat(range).link === originalLink &&
    editor.yTextString.slice(range.index, range.index + range.length) ===
      originalText;
  if (!host || !valid() || !range.length) return;
  let selection = range;
  mountInlinePopup(
    std,
    () => (valid() ? editor.toDomRange(range) : null),
    (controls) =>
      host.renderLinkEditor({
        ...controls,
        editing: type === "edit",
        text: originalText,
        url: originalLink ?? "",
        isValidUrl: (url) => isValidUrl(url.trim()),
        confirm: (url, text) => {
          if (abort.signal.aborted || !valid() || !isValidUrl(url.trim()))
            return;
          const attributes = {
            link: normalizeUrl(url.trim()),
            reference: null,
          };
          if (type === "edit") {
            editor.insertText(range, text, attributes);
            selection = { index: range.index, length: text.length };
          } else {
            editor.formatText(range, attributes);
          }
          controls.close();
        },
      }),
    abort,
    () => {
      if (
        !std.store.readonly &&
        editor.rootElement?.isConnected &&
        editor.isValidInlineRange(selection)
      ) {
        std.event.active = true;
        editor.rootElement.focus({ preventScroll: true });
        editor.setInlineRange(selection);
        // Cancelling keeps the same signal value; restore its DOM range explicitly.
        editor.syncInlineRange(selection);
      }
    },
  );
}
