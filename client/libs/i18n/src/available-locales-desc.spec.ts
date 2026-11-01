/**
 * INV-AVAILABLE-LOCALES-DESC-1: The descriptor text shown to admins for the
 *                                `admin.config.i18n.availableLocales` config
 *                                key must enumerate every locale code that
 *                                SUPPORTED_LANGUAGES actually registers.
 *
 * Rationale: without a full list the admin has no in-UI way to know which
 * codes are valid — they would have to read source to configure the setting.
 */
import { describe, expect, test } from "vitest";

import {
  SUPPORTED_LANGUAGE_CODES,
  SUPPORTED_LANGUAGE_LABEL_KEYS,
} from "./resources";

const KEY = "admin.config.i18n.availableLocales.desc";
const LABEL_PREFIX = "com.myoxus.locale.option.";
const modules = (
  import.meta as ImportMeta & {
    glob: <T>(pattern: string, options: { eager: true }) => Record<string, T>;
  }
).glob<{ default: Record<string, string> }>("./resources/*.json", {
  eager: true,
});

const LOCALES = Object.fromEntries(
  Object.entries(modules).map(([path, module]) => [
    path.match(/\.\/resources\/(.+)\.json$/)?.[1] ?? path,
    module.default,
  ]),
) as Record<string, Record<string, string>>;

const REGISTERED_LOCALES = Object.fromEntries(
  SUPPORTED_LANGUAGE_CODES.map((code) => [code, LOCALES[code]]),
) as Record<string, Record<string, string>>;

const DESC_LOCALES = Object.fromEntries(
  Object.entries(LOCALES).filter(([, dict]) => KEY in dict),
);

const CODES = [...SUPPORTED_LANGUAGE_CODES];

function listedCodes(desc: string): string[] {
  const rawList = desc.slice(desc.lastIndexOf(":") + 1).replace(/\.$/, "");
  return rawList
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

describe("INV-AVAILABLE-LOCALES-DESC-1: desc enumerates all registered locale codes", () => {
  test.each(Object.entries(DESC_LOCALES))(
    "%s.admin.config.i18n.availableLocales.desc lists exactly every SUPPORTED_LANGUAGE_CODES entry",
    (lang, dict) => {
      const desc = dict[KEY];
      expect(typeof desc, `${lang}.${KEY} missing`).toBe("string");
      expect(listedCodes(desc)).toEqual(CODES);
    },
  );

  test.each(Object.entries(DESC_LOCALES))(
    "%s desc is substantive (>80 chars) — not just a stub",
    (_lang, dict) => {
      expect(dict[KEY].length).toBeGreaterThan(80);
    },
  );

  test.each(["de", "fr", "es"] as const)(
    "%s desc is translated (not left as English)",
    (lang) => {
      expect(LOCALES[lang][KEY]).not.toBe(LOCALES.en[KEY]);
    },
  );
});

describe("INV-LOCALE-OPTION-LABELS-1: shared locale labels cover the web language selector", () => {
  test.each(CODES)("%s has a shared label key", (code) => {
    expect(SUPPORTED_LANGUAGE_LABEL_KEYS[code]).toBe(`${LABEL_PREFIX}${code}`);
  });

  test.each(Object.entries(REGISTERED_LOCALES))(
    "%s has every shared locale option label",
    (locale, dict) => {
      const missing = CODES.filter(
        (code) => typeof dict[`${LABEL_PREFIX}${code}`] !== "string",
      );
      expect(missing, `${locale} missing shared locale labels`).toEqual([]);
    },
  );

  test("de owns real shared labels for the visible language selector examples", () => {
    expect(LOCALES.de["com.myoxus.locale.option.en"]).toBe("Englisch");
    expect(LOCALES.de["com.myoxus.locale.option.de"]).toBe("Deutsch");
    expect(LOCALES.de["com.myoxus.locale.option.fr"]).toBe("Französisch");
    expect(LOCALES.de["com.myoxus.locale.option.es"]).toBe("Spanisch");
  });

  test("locale option labels are not adminfrontend-specific keys", () => {
    const offenders = Object.entries(LOCALES).flatMap(([locale, dict]) =>
      Object.keys(dict)
        .filter((key) => key.startsWith("admin.system.locale.option."))
        .map((key) => `${locale}:${key}`),
    );
    expect(offenders).toEqual([]);
  });
});
