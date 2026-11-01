/**
 * INV-DE-NAT-1: de.json uses the Du-form consistently in UX-facing copy.
 *                Sie-form imperatives ("Verwenden Sie", "Geben Sie",
 *                "Aktivieren Sie", "Bestätigen Sie") leak formal tone into
 *                a locale that is otherwise Du throughout, per the
 *                terminology glossary ("Ganze de.json: Du-Form").
 *
 * INV-DE-NAT-2: de.json is free of small naturalness bugs fixed under
 *                P123-A-04 (Version 0,18 decimal comma, "Knopf" for
 *                button, "vergib ein Passwort", rükgängig typo).
 *
 * Sie-form is only permitted in explicitly formal/legal contexts. As of
 * P123-A-04 the count of Sie-form imperatives in user-facing copy is
 * zero; this guard locks that in.
 */
import { describe, expect, test } from "vitest";

import de from "./resources/de.json";

const entries = Object.entries(de as Record<string, string>);

const matching = (pattern: RegExp): Array<[string, string]> =>
  entries.filter(([, v]) => pattern.test(v));

describe("INV-DE-NAT-1: de.json uses Du-form consistently", () => {
  // Common Sie-form imperatives that should have been converted. Each
  // pattern targets a specific verb to keep error messages readable.
  const sieImperatives: Array<[string, RegExp]> = [
    ["Geben Sie", /\bGeben Sie\b/],
    ["Verwenden Sie", /\bVerwenden Sie\b/],
    ["Aktivieren Sie", /\bAktivieren Sie\b/],
    ["Bestätigen Sie", /\bBestätigen Sie\b/],
    ["Erstellen Sie", /\bErstellen Sie\b/],
    ["Fügen Sie", /\bFügen Sie\b/],
    ["Drücken Sie", /\bDrücken Sie\b/],
    ["Importieren Sie", /\bImportieren Sie\b/],
  ];

  test.each(sieImperatives)("%s has no remaining occurrences", (_, pattern) => {
    const hits = matching(pattern);
    expect(
      hits,
      `${hits.length} string(s) still use Sie-form: ${hits.map(([k]) => k).join(", ")}`,
    ).toEqual([]);
  });
});

describe("INV-DE-NAT-2: de.json is free of P123-A-04 naturalness bugs", () => {
  test('no "Version 0,18" decimal-comma version strings', () => {
    const hits = matching(/Version \d+,\d+/);
    expect(hits, `Found ${hits.length} decimal-comma version(s)`).toEqual([]);
  });

  test('"Knopf" is not used for UI button — prefer "Schaltfläche"', () => {
    const hits = matching(/\bKnopf\b/);
    expect(hits, `Found ${hits.length} Knopf-occurrence(s)`).toEqual([]);
  });

  test('no "vergib ein Passwort" / "Passwort vergeben" — use festlegen', () => {
    const hits = matching(
      /\b(vergib|Vergib) ein Passwort\b|\bPasswort vergeben\b/,
    );
    expect(hits, `Found ${hits.length} vergeben/vergib-hits`).toEqual([]);
  });

  test('no "rükgängig" typo — must be "rückgängig"', () => {
    const hits = matching(/rükgängig/);
    expect(hits, `Found ${hits.length} rükgängig-hits`).toEqual([]);
  });
});
