// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EditorChromeHostIdentifier,
  mountInlinePopup,
} from "@virgultum/core/services";
import type { MyoxusInlineEditor } from "@virgultum/core/types";
import { isValidUrl, normalizeUrl } from "@virgultum/core/utils";
import type { BlockStdScope } from "@virgultum/core/runtime";
import type { InlineRange } from "@virgultum/core/runtime/inline";

export function openLinkEditor(
  std: BlockStdScope,
  type: "create" | "edit" | "insert",
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
  if (!host || !valid() || (!range.length && type !== "insert")) return;
  let selection = range;
  mountInlinePopup(
    std,
    () => (valid() ? editor.toDomRange(range) : null),
    (anchor, controls) =>
      host.mountLinkEditor(anchor, {
        ...controls,
        editing: type !== "create",
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
          if (type !== "create") {
            const label = text || normalizeUrl(url.trim());
            std.store.captureSync();
            editor.insertText(range, label, attributes);
            std.store.captureSync();
            selection =
              type === "insert"
                ? { index: range.index + label.length, length: 0 }
                : { index: range.index, length: label.length };
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
