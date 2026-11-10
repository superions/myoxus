// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  CitationProvider,
  EditorChromeHostIdentifier,
  editorMessage,
  mountInlinePopup,
} from "@virgultum/shared/services";
import { editorToast } from "@virgultum/shared/utils";
import type { AttachmentBlockComponent } from "./attachment-block";

/** Bind rename to this live attachment; concurrent renames invalidate the form. */
export function openAttachmentRename(
  block: AttachmentBlockComponent,
  abort: AbortController,
) {
  const { model, std, store } = block;
  const host = std.getOptional(EditorChromeHostIdentifier);
  const original = model.props.name;
  const dot = original.lastIndexOf(".");
  const split = dot > 0 && original.length - dot <= 7;
  const extension = split ? original.slice(dot) : "";
  const valid = () =>
    !store.readonly &&
    block.isConnected &&
    store.getBlock(model.id)?.model === model &&
    model.props.name === original;
  if (!host || !valid()) {
    abort.abort();
    return;
  }
  mountInlinePopup(
    std,
    () => (valid() ? block : null),
    (controls) =>
      host.renderAttachmentRename({
        ...controls,
        name: split ? original.slice(0, dot) : original,
        extension,
        confirm: (name) => {
          if (abort.signal.aborted || !valid()) return;
          const next = name + extension;
          if (!next) {
            editorToast(
              std.host,
              editorMessage(
                "com.myoxus.editor.attachment.empty-name",
                "File name cannot be empty",
              ),
            );
            return;
          }
          if (next !== original) {
            store.updateBlock(model, { name: next });
            const citations = std.getOptional(CitationProvider);
            if (citations?.isCitationModel(model)) citations.trackEvent("Edit");
          }
          controls.close();
        },
      }),
    abort,
    () => {
      if (block.isConnected && store.getBlock(model.id)?.model === model) {
        std.event.active = true;
        std.host.focus({ preventScroll: true });
      }
    },
  );
}
