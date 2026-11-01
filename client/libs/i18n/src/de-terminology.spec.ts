/**
 * INV-DE-TERM-1: The binding German terminology rules from
 *                `docs/dev/clients/i18n-glossary.md` hold in de.json.
 *
 * This test encodes the choices made in P123-A-03 so that a future
 * translation cannot silently drift: if somebody reintroduces
 * "Kollektion" or switches "Besitzer" back to "Inhaber", CI fails.
 */
import { describe, expect, test } from "vitest";

import de from "./resources/de.json";

const values = Object.entries(de as Record<string, string>);

const countMatches = (pattern: RegExp): Array<[string, string]> =>
  values.filter(([, v]) => pattern.test(v));

describe("INV-DE-TERM-1: de.json respects binding glossary terminology", () => {
  test('"Kollektion" is never used — always "Sammlung"', () => {
    const hits = countMatches(/\bKollekt/i);
    expect(hits, `Found ${hits.length} Kollektion-hits`).toHaveLength(0);
  });

  test('"Inhaber" is never used for "Owner" — always "Besitzer"', () => {
    // "Inhaber" could legitimately appear in unrelated contexts (e.g. Token-Inhaber),
    // but owner-of-workspace context must use Besitzer. P114-C-01 already converted
    // all owner-context occurrences; guard against regression.
    const hits = countMatches(/\bInhaber\b/);
    expect(hits, `Found ${hits.length} Inhaber-hits`).toHaveLength(0);
  });

  test('Sign-in uses "Anmelden" not "Einloggen"', () => {
    const hits = countMatches(/\bEinloggen\b|\bausloggen\b/i);
    expect(hits, `Found ${hits.length} Einloggen/Ausloggen-hits`).toHaveLength(
      0,
    );
  });

  test("Synchronisierung dominates over Synchronisation for non-compound contexts", () => {
    // Enforced weakly: at least 3× as many "Synchronisierung" as standalone
    // "Synchronisation" (i.e. Synchronisation not in compound form).
    const sierung = countMatches(/Synchronisierung/).length;
    // Standalone = not preceded by "-" (which would mark it as compound like Git-)
    const sation = values.filter(([, v]) =>
      /(?<!-)Synchronisation\b/.test(v),
    ).length;
    expect(sierung).toBeGreaterThanOrEqual(sation * 3);
  });
});
