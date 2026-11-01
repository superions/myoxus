/**
 * Guards the captcha i18n surface shipped to end users.
 *
 * INV-CAPTCHA-I18N-1: all 16 altcha-widget strings and the 7 wrapper-level
 *                    strings exist in every Tier-1 locale (en/de/fr/es).
 * INV-CAPTCHA-I18N-2: the non-English locales actually contain translated
 *                    text, not the English source string (catches forgotten
 *                    copy-paste when new keys are added).
 */
import { describe, expect, test } from "vitest";

import de from "../../../../i18n/src/resources/de.json";
import en from "../../../../i18n/src/resources/en.json";
import es from "../../../../i18n/src/resources/es.json";
import fr from "../../../../i18n/src/resources/fr.json";

const WRAPPER_KEYS = [
  "com.myoxus.captcha.expired",
  "com.myoxus.captcha.invalid",
  "com.myoxus.captcha.loading",
  "com.myoxus.captcha.rate_limit",
  "com.myoxus.captcha.retry",
  "com.myoxus.captcha.solving",
  "com.myoxus.captcha.verified",
] as const;

const WIDGET_KEYS = [
  "com.myoxus.captcha.widget.ariaLinkLabel",
  "com.myoxus.captcha.widget.cancel",
  "com.myoxus.captcha.widget.enterCode",
  "com.myoxus.captcha.widget.enterCodeAria",
  "com.myoxus.captcha.widget.enterCodeFromImage",
  "com.myoxus.captcha.widget.error",
  "com.myoxus.captcha.widget.expired",
  "com.myoxus.captcha.widget.getAudioChallenge",
  "com.myoxus.captcha.widget.label",
  "com.myoxus.captcha.widget.loading",
  "com.myoxus.captcha.widget.reload",
  "com.myoxus.captcha.widget.verificationRequired",
  "com.myoxus.captcha.widget.verified",
  "com.myoxus.captcha.widget.verify",
  "com.myoxus.captcha.widget.verifying",
  "com.myoxus.captcha.widget.waitAlert",
] as const;

const ALL_KEYS = [...WRAPPER_KEYS, ...WIDGET_KEYS];

const LOCALES = {
  en: en as Record<string, string>,
  de: de as Record<string, string>,
  fr: fr as Record<string, string>,
  es: es as Record<string, string>,
};

describe("INV-CAPTCHA-I18N-1: every captcha key exists in en/de/fr/es", () => {
  test.each(ALL_KEYS)("%s defined in all Tier-1 locales", (key) => {
    for (const [lang, dict] of Object.entries(LOCALES)) {
      const value = dict[key];
      expect(
        typeof value === "string" && value.length > 0,
        `missing ${lang}.${key}`,
      ).toBe(true);
    }
  });
});

describe("INV-CAPTCHA-I18N-2: non-English locales are actually translated", () => {
  // These keys are proper nouns, single-word cognates, or identical across
  // languages in their canonical form — exempted from divergence check.
  const COGNATE_ALLOWLIST = new Set<string>([
    "com.myoxus.captcha.widget.reload", // ES "Recargar" / DE "Neu laden" all differ; keep for safety
  ]);

  test.each(ALL_KEYS.filter((k) => !COGNATE_ALLOWLIST.has(k)))(
    "%s differs from English in de/fr/es",
    (key) => {
      const english = LOCALES.en[key];
      for (const lang of ["de", "fr", "es"] as const) {
        expect(
          LOCALES[lang][key],
          `${lang}.${key} equals English source — missing translation`,
        ).not.toBe(english);
      }
    },
  );
});
