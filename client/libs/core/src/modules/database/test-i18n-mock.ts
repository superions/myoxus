// SPDX-License-Identifier: AGPL-3.0-or-later

import english from "../../../../i18n/src/resources/en.json";

const TEST_SENTINELS: Partial<Record<keyof typeof english, string>> = {
  // Distinguishes semantic Status-group localization from a stored Select label.
  "com.myoxus.database.progress.group.active": "Localized active",
};

function resolveEnglishMessage(
  key: string,
  resolving = new Set<string>(),
): string {
  if (resolving.has(key)) return key;
  const nextResolving = new Set(resolving).add(key);
  const source =
    TEST_SENTINELS[key as keyof typeof english] ??
    english[key as keyof typeof english] ??
    key;
  return source.replace(/\$t\(([^)]+)\)/g, (_match, reference: string) =>
    resolveEnglishMessage(reference, nextResolving),
  );
}

/** Test adapter that keeps Database assertions aligned with generated copy. */
export function createDatabaseTestI18nModule() {
  const i18n = new Proxy(
    { language: "en" },
    {
      get(target, property) {
        if (property === "language") return target.language;
        if (property === "t")
          return (key: string, fallback?: string) =>
            Object.hasOwn(english, key)
              ? resolveEnglishMessage(key)
              : (fallback ?? key);
        return (values?: Record<string, string>) => {
          const template = resolveEnglishMessage(String(property));
          if (!values) return template;
          return Object.entries(values).reduce(
            (text, [key, value]) =>
              text.replace(new RegExp(`{{\\s*${key}\\s*}}`, "g"), value),
            template,
          );
        };
      },
    },
  );
  return { I18n: i18n, useI18n: () => i18n };
}
