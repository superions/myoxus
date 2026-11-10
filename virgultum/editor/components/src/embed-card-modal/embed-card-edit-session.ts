// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EmbedLinkedDocModel,
  EmbedSyncedDocModel,
  isInternalEmbedModel,
  type AliasInfo,
  type LinkableEmbedModel,
} from "@virgultum/model";
import {
  EditorChromeHostIdentifier,
  editorMessage,
  mountInlinePopup,
  TelemetryProvider,
} from "@virgultum/shared/services";
import { editorToast } from "@virgultum/shared/utils";
import type { BlockComponent, BlockStdScope, EditorHost } from "@virgultum/std";

/** Edits this card's presentation only; document aliases keep their existing callbacks. */
export function toggleEmbedCardEditModal(
  editor: EditorHost,
  model: LinkableEmbedModel,
  viewType: string,
  originalDocInfo?: AliasInfo,
  onReset?: (std: BlockStdScope, component: BlockComponent) => void,
  onSave?: (
    std: BlockStdScope,
    component: BlockComponent,
    props: AliasInfo,
  ) => void,
  abort = new AbortController(),
) {
  const { std, store } = editor;
  const chrome = std.getOptional(EditorChromeHostIdentifier);
  const original = {
    title: model.props.title,
    description: model.props.description,
  };
  const block = std.view.getBlock(model.id);
  const valid = () =>
    editor.isConnected &&
    block?.isConnected &&
    !store.readonly &&
    store.getBlock(model.id)?.model === model &&
    model.props.title === original.title &&
    model.props.description === original.description;
  if (!chrome || !valid()) {
    abort.abort();
    return;
  }
  const internal = isInternalEmbedModel(model);
  const track = (event: "SavedAlias" | "ResetedAlias", control: string) =>
    std.getOptional(TelemetryProvider)?.track(event, {
      segment: "toolbar",
      page: "doc editor",
      module: "embed card edit popup",
      type: `${viewType} view`,
      category: internal ? "linked doc" : "link",
      control,
    });
  mountInlinePopup(
    std,
    () => (valid() ? block! : null),
    (controls) =>
      chrome.renderEmbedCardEdit({
        ...controls,
        title: original.title || originalDocInfo?.title || "",
        description: original.description || originalDocInfo?.description || "",
        internal,
        mode:
          model instanceof EmbedLinkedDocModel
            ? "linked"
            : model instanceof EmbedSyncedDocModel
              ? "synced"
              : "external",
        canReset: !!(original.title || original.description),
        confirm: (title, description) => {
          if (abort.signal.aborted || !valid()) return;
          if (!title.trim()) {
            editorToast(
              std.host,
              editorMessage(
                "com.myoxus.editor.embed.empty-title",
                "Title can not be empty",
              ),
            );
            return;
          }
          store.captureSync();
          try {
            onSave?.(std, block!, {
              title: title.trim(),
              description: description.trim(),
            });
            track("SavedAlias", "save");
          } finally {
            store.captureSync();
            controls.close();
          }
        },
        reset: () => {
          if (
            abort.signal.aborted ||
            !valid() ||
            !(model instanceof EmbedLinkedDocModel)
          )
            return;
          store.captureSync();
          try {
            store.updateBlock(model, { title: null, description: null });
            onReset?.(std, block!);
            block!.requestUpdate();
            track("ResetedAlias", "reset");
          } finally {
            store.captureSync();
            controls.close();
          }
        },
      }),
    abort,
    () => {
      if (editor.isConnected) {
        std.event.active = true;
        editor.focus({ preventScroll: true });
      }
    },
  );
}
