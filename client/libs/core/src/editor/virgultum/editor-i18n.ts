// SPDX-License-Identifier: AGPL-3.0-or-later

import { I18n } from "@myoxus/i18n";
import { signal } from "@preact/signals-core";
import type {
  EditorI18nAdapter,
  EditorI18nMessage,
} from "@virgultum/editor/shared/services";

const locale$ = signal(I18n.language || "en");
let configured = false;

/**
 * The ViewProvider is a singleton, so the central language listener must be
 * installed once and shared by every editor scope created afterwards.
 */
export function configureEditorI18n(): EditorI18nAdapter {
  if (!configured) {
    I18n.on("languageChanged", (language: string) => {
      locale$.value = language;
    });
    configured = true;
  }

  locale$.value = I18n.language || "en";

  return {
    locale$,
    translate: (message: EditorI18nMessage) =>
      I18n.t(message.key, message.fallback, message.values),
  };
}
