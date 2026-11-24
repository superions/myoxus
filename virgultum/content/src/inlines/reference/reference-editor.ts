// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ReferenceInfo } from "@virgultum/core/models";
import { REFERENCE_NODE } from "@virgultum/core/consts";
import {
  EditorChromeHostIdentifier,
  mountInlinePopup,
  TelemetryProvider,
} from "@virgultum/core/services";
import type { MyoxusInlineEditor } from "@virgultum/core/types";
import { cloneReferenceInfoWithoutAliases } from "@virgultum/core/utils";
import type { BlockStdScope } from "@virgultum/core/runtime";
import type { InlineRange } from "@virgultum/core/runtime/inline";

export function openReferenceEditor(
  std: BlockStdScope,
  docTitle: string,
  referenceInfo: ReferenceInfo,
  editor: MyoxusInlineEditor,
  range: InlineRange,
  abort: AbortController,
) {
  const host = std.getOptional(EditorChromeHostIdentifier);
  const original = JSON.stringify(editor.getFormat(range).reference);
  const valid = () =>
    !std.store.readonly &&
    editor.rootElement?.isConnected &&
    editor.isValidInlineRange(range) &&
    JSON.stringify(editor.getFormat(range).reference) === original;
  if (!host || !valid() || !original) return;
  let selection = range;
  mountInlinePopup(
    std,
    () => (valid() ? editor.toDomRange(range) : null),
    (anchor, controls) => {
      const apply = (title?: string) => {
        if (abort.signal.aborted || !valid()) return;
        const next =
          title === undefined
            ? cloneReferenceInfoWithoutAliases(referenceInfo)
            : { ...referenceInfo, title };
        editor.insertText(range, REFERENCE_NODE, {
          reference: { ...next, type: "LinkedPage" },
        });
        selection = { index: range.index + REFERENCE_NODE.length, length: 0 };
        std
          .getOptional(TelemetryProvider)
          ?.track(title === undefined ? "ResetedAlias" : "SavedAlias", {
            segment: "doc",
            page: "doc editor",
            module: "toolbar",
            category: "linked doc",
            type: "inline view",
            control: title === undefined ? "reset" : "save",
          });
        controls.close();
      };
      return host.mountReferenceEditor(anchor, {
        ...controls,
        title: referenceInfo.title ?? docTitle,
        confirm: (title) => {
          if (title.trim()) apply(title.trim());
          else controls.close();
        },
        reset: () => apply(),
      });
    },
    abort,
    () => {
      if (
        !std.store.readonly &&
        editor.rootElement?.isConnected &&
        editor.isValidInlineRange(selection)
      ) {
        std.event.active = true;
        editor.setInlineRange(selection);
        editor.syncInlineRange(selection);
      }
    },
  );
}
