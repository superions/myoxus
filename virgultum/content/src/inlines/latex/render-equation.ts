// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import type { BlockStdScope } from "@virgultum/core/runtime";
import katex from "katex";

/** The editor keeps the source even when KaTeX cannot lay it out. */
export function renderEquation(
  std: BlockStdScope,
  container: HTMLElement,
  source: string,
  displayMode: boolean,
) {
  if (source) {
    try {
      katex.render(source, container, { displayMode });
      return;
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error;
    }
  }
  const i18n = std.getOptional(EditorI18nProvider) ?? undefined;
  void i18n?.locale$.value;
  const message = source
    ? editorMessage("com.myoxus.editor.equation.invalid", "Invalid equation")
    : editorMessage("com.myoxus.editor.slash.equation", "Equation");
  const placeholder = container.ownerDocument.createElement("span");
  placeholder.className = displayMode
    ? source
      ? "latex-block-error-placeholder"
      : "latex-block-empty-placeholder"
    : source
      ? "error-placeholder"
      : "placeholder";
  placeholder.textContent = resolveEditorMessage(message, i18n);
  container.replaceChildren(placeholder);
}
