/**
 * @vitest-environment node
 */
/**
 * i18n-completenesses.json consistency tests.
 *
 * Invariants:
 *   inv_i18n_completeness_json_no_missing — every SUPPORTED_LANGUAGES entry has a completeness value
 *   inv_i18n_completeness_json_no_orphans — no completeness entry for unregistered languages
 *   inv_i18n_completeness_json_values_in_range — all values are 0–100
 *
 * These tests catch drift between SUPPORTED_LANGUAGES and i18n-completenesses.json.
 * Adding a language to index.ts without updating the JSON will immediately fail here.
 *
 * Current known state (2026-04-17):
 *   inv_i18n_completeness_json_no_orphans will FAIL until P122-A registers el-GR.
 *   After P122-A: both tests should be green.
 */
import { SUPPORTED_LANGUAGES } from "@myoxus/i18n";
import { describe, expect, test } from "vitest";

const COMPLETENESS_PATH = "../../../i18n/src/i18n-completenesses.json";

describe("i18n-completenesses.json consistency", () => {
  test("inv_i18n_completeness_json_no_missing", async () => {
    const completeness = (await import(COMPLETENESS_PATH).then(
      (m) => m.default ?? m,
    )) as Record<string, number>;
    const supported = Object.keys(SUPPORTED_LANGUAGES);
    const missing = supported.filter((lang) => !(lang in completeness));
    expect(
      missing,
      `Languages in SUPPORTED_LANGUAGES without completeness entry: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("inv_i18n_completeness_json_no_orphans", async () => {
    const completeness = (await import(COMPLETENESS_PATH).then(
      (m) => m.default ?? m,
    )) as Record<string, number>;
    const supported = Object.keys(SUPPORTED_LANGUAGES);
    const orphans = Object.keys(completeness).filter(
      (lang) => !supported.includes(lang),
    );
    expect(
      orphans,
      `Completeness entries for unregistered languages: ${orphans.join(", ")} — register in SUPPORTED_LANGUAGES or remove from completenesses`,
    ).toEqual([]);
  });

  test("inv_i18n_completeness_json_values_in_range", async () => {
    const completeness = (await import(COMPLETENESS_PATH).then(
      (m) => m.default ?? m,
    )) as Record<string, number>;
    const invalid = Object.entries(completeness).filter(
      ([, v]) => typeof v !== "number" || v < 0 || v > 100,
    );
    expect(
      invalid.map(([k, v]) => `${k}: ${v}`),
      "Completeness values must be numbers 0–100",
    ).toEqual([]);
  });
});
