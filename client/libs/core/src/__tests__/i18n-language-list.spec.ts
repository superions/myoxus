/**
 * @vitest-environment happy-dom
 */
/**
 * Invariant tests for I18n.languageList$ filtering.
 *
 * These tests ensure that the admin-configured `availableLocales` are correctly
 * propagated to the web frontend language selector — and that regressions in
 * this pipe are caught immediately.
 *
 * Invariants:
 *   inv_i18n_01 — null availableLocales → all supported locales
 *   inv_i18n_02 — empty array → all supported locales (fallback)
 *   inv_i18n_03 — valid subset → only those locales, nothing else
 *   inv_i18n_04 — unknown locale in array → silently excluded
 *   inv_i18n_05 — order is preserved (not alphabetical, not insertion)
 *   inv_i18n_06 — reactive: changing availableLocales$ updates languageList$
 */
import { I18n } from "@myoxus/core/modules/i18n/entities/i18n";
import { I18nService } from "@myoxus/core/modules/i18n/services/i18n";
import { SUPPORTED_LANGUAGES } from "@myoxus/i18n";
import { Framework } from "@myoxus/infra";
import { describe, expect, test } from "vitest";

function createI18n(): I18n {
  const framework = new Framework();
  framework.entity(I18n).service(I18nService);
  const provider = framework.provider();
  return provider.get(I18nService).i18n;
}

describe("I18n.languageList$ — availableLocales filtering", () => {
  test("inv_i18n_01_null_returns_all: null availableLocales → all supported locales", () => {
    const i18n = createI18n();
    i18n.availableLocales$.next(null);
    const allKeys = Object.keys(SUPPORTED_LANGUAGES);
    expect(i18n.languageList$.value.length).toBe(allKeys.length);
  });

  test("inv_i18n_02_empty_returns_all: empty array → all supported locales", () => {
    const i18n = createI18n();
    i18n.availableLocales$.next([]);
    const allKeys = Object.keys(SUPPORTED_LANGUAGES);
    expect(i18n.languageList$.value.length).toBe(allKeys.length);
  });

  test('inv_i18n_03_filter_valid: ["de","en"] → exactly de and en', () => {
    const i18n = createI18n();
    i18n.availableLocales$.next(["de", "en"]);
    const list = i18n.languageList$.value;
    expect(list.length).toBe(2);
    expect(list.map((l) => l.key)).toContain("de");
    expect(list.map((l) => l.key)).toContain("en");
  });

  test('inv_i18n_04_unknown_locale_excluded: "INVALID" locale → excluded, no crash', () => {
    const i18n = createI18n();
    i18n.availableLocales$.next(["de", "en", "INVALID_LOCALE_XYZ"]);
    const list = i18n.languageList$.value;
    // Only 2 valid entries — the unknown locale is silently dropped
    expect(list.length).toBe(2);
    expect(list.map((l) => l.key)).not.toContain("INVALID_LOCALE_XYZ");
  });

  test('inv_i18n_05_order_preserved: ["fr","de"] → fr first, de second', () => {
    const i18n = createI18n();
    i18n.availableLocales$.next(["fr", "de"]);
    const list = i18n.languageList$.value;
    expect(list.length).toBe(2);
    expect(list[0].key).toBe("fr");
    expect(list[1].key).toBe("de");
  });

  test("inv_i18n_06_reactive: changing availableLocales$ updates languageList$", () => {
    const i18n = createI18n();
    // Start: null → all languages
    i18n.availableLocales$.next(null);
    const allCount = i18n.languageList$.value.length;
    expect(allCount).toBeGreaterThan(2);

    // Restrict to 2
    i18n.availableLocales$.next(["de", "en"]);
    expect(i18n.languageList$.value.length).toBe(2);

    // Expand to 3
    i18n.availableLocales$.next(["de", "en", "fr"]);
    expect(i18n.languageList$.value.length).toBe(3);

    // Reset to null → all again
    i18n.availableLocales$.next(null);
    expect(i18n.languageList$.value.length).toBe(allCount);
  });
});
