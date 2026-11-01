// SPDX-License-Identifier: AGPL-3.0-or-later

import { signal, type Signal } from "@preact/signals-core";
import { createIdentifier } from "@virgultum/global/di";
import { Extension, type ExtensionType } from "@virgultum/store";

import { legacyEditorMessage } from "./legacy-editor-text";

export type EditorI18nValue = string | number | boolean | null | undefined;

export type EditorI18nValues = Readonly<Record<string, EditorI18nValue>>;

/**
 * A visible editor message keeps its stable resource key and standalone
 * English fallback together. Callers must keep `key` literal so the central
 * i18n coverage gate can discover and validate it.
 */
export type EditorI18nMessage = Readonly<{
  key: string;
  fallback: string;
  values?: EditorI18nValues;
}>;

export type EditorI18nAdapter = Readonly<{
  locale$: Signal<string>;
  translate: (message: EditorI18nMessage) => string | undefined;
}>;

export interface EditorI18nService {
  readonly locale$: Signal<string>;
  translate(message: EditorI18nMessage): string;
}

export const EditorI18nProvider = createIdentifier<EditorI18nService>(
  "MyoxusEditorI18nService",
);

const fallbackLocale$ = signal("en");

export function editorMessage(
  key: string,
  fallback: string,
  values?: EditorI18nValues,
): EditorI18nMessage {
  return Object.freeze({
    key,
    fallback,
    ...(values === undefined ? {} : { values }),
  });
}

export function interpolateEditorMessage(
  value: string,
  values?: EditorI18nValues,
) {
  if (!values) return value;

  return value.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
    const replacement = values[token];
    return replacement === undefined || replacement === null
      ? match
      : String(replacement);
  });
}

export function resolveEditorMessage(
  message: EditorI18nMessage,
  service?: EditorI18nService,
) {
  return (
    service?.translate(message) ??
    interpolateEditorMessage(message.fallback, message.values)
  );
}

/** Resolve mixed legacy/descriptor display contracts without changing action IDs. */
export function resolveEditorText(
  value: string | EditorI18nMessage | undefined,
  service?: EditorI18nService,
) {
  return typeof value === "string"
    ? resolveLegacyEditorText(value, service)
    : value === undefined
      ? undefined
      : resolveEditorMessage(value, service);
}

/**
 * Transitional resolver for untouched editor surfaces. It only consults an
 * existing central key whose English fallback is identical to the legacy
 * visible string; stable migrated contracts must use `editorMessage` directly.
 */
export function resolveLegacyEditorText(
  value: string | undefined,
  service?: EditorI18nService,
) {
  if (value === undefined) return undefined;
  return resolveEditorMessage(legacyEditorMessage(value), service);
}

export class DefaultEditorI18nService
  extends Extension
  implements EditorI18nService
{
  readonly locale$;

  constructor(private readonly adapter?: EditorI18nAdapter) {
    super();
    this.locale$ = adapter?.locale$ ?? fallbackLocale$;
  }

  translate(message: EditorI18nMessage) {
    // Reading the signal makes SignalWatcher-backed Lit renderers reactive.
    void this.locale$.value;
    const translated = this.adapter?.translate(message);
    if (translated?.trim() && translated !== message.key) return translated;
    return interpolateEditorMessage(message.fallback, message.values);
  }
}

export function EditorI18nExtension(
  adapter?: EditorI18nAdapter,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(
        EditorI18nProvider,
        () => new DefaultEditorI18nService(adapter),
      );
    },
  };
}
