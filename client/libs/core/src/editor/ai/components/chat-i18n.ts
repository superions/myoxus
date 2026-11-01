// SPDX-License-Identifier: AGPL-3.0-or-later

import { I18n, type I18nInstance } from "@myoxus/i18n";

import { configureEditorI18n } from "../../virgultum/editor-i18n";

/** Read inside a SignalWatcher render so mounted chat elements follow locale changes. */
export function chatI18n(): I18nInstance {
  const { locale$ } = configureEditorI18n();
  void locale$.value;
  return I18n;
}
