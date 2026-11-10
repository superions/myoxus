// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  EditorI18nProvider,
  MyoxusHostServiceIdentifier,
} from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import type { BlockModel } from "@virgultum/store";
import { focusTextModel, getInlineEditorByModel } from "./dom";

/** Capture a native text position before the shared chooser takes focus. */
export function openTemplateFieldPicker(std: BlockStdScope, model: BlockModel) {
  const store = std.store;
  const host = std.getOptional(MyoxusHostServiceIdentifier);
  const editor = getInlineEditorByModel(std, model);
  if (!host?.openTemplateVariablePicker || !editor || !model.text) return;
  const range = editor.getInlineRange() ?? {
    index: model.text.length,
    length: 0,
  };
  let nextCaret = range.index;
  host.openTemplateVariablePicker({
    i18n: std.getOptional(EditorI18nProvider) ?? undefined,
    templateSource: host.isTemplateDocument(),
    canWrite: () =>
      !store.readonly &&
      !editor.isReadonly &&
      Boolean(editor.eventSource?.isConnected) &&
      store.getModelById(model.id) === model,
    insert: (token) => {
      if (!host.isTemplateDocument()) return;
      store.captureSync();
      editor.insertText(range, token);
      nextCaret = range.index + token.length;
      store.captureSync();
    },
    insertField: (field) => {
      if (field.type === "input" && !host.isTemplateDocument()) return;
      store.captureSync();
      editor.insertText(range, " ", { documentField: field });
      nextCaret = range.index + 1;
      store.captureSync();
    },
    onClose: () => {
      if (store.getModelById(model.id))
        focusTextModel(std, model.id, nextCaret);
    },
  });
}
