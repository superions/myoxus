// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "./i18n-service";

export const textProtectionMessages = {
  protect: editorMessage(
    "com.myoxus.editor.text-protection.protect",
    "Protect text when used",
  ),
  unprotect: editorMessage(
    "com.myoxus.editor.text-protection.unprotect",
    "Keep text editable when used",
  ),
  fixed: editorMessage("com.myoxus.editor.text-protection.fixed", "Fixed text"),
  fixedDescription: editorMessage(
    "com.myoxus.editor.text-protection.fixed-description",
    "This text is fixed. You can still fill its input fields.",
  ),
  sourceDescription: editorMessage(
    "com.myoxus.editor.text-protection.source-description",
    "This source stays editable. New uses protect this text while keeping input fields fillable.",
  ),
};

export function textProtectionHint(
  mode: unknown,
  i18n?: EditorI18nService,
): string {
  if (mode === "fixed")
    return resolveEditorMessage(textProtectionMessages.fixedDescription, i18n);
  if (mode === "source")
    return resolveEditorMessage(textProtectionMessages.sourceDescription, i18n);
  return "";
}
