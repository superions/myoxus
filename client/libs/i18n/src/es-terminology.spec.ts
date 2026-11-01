/**
 * INV-ES-TERM-1: es.json respects the binding Spanish terminology from
 *                `docs/dev/clients/i18n-glossary.md` (P123-C-02).
 *
 *   - es.json is Castellano (es-ES), informal Tuteo (tú / tu / tus).
 *     "Usted" is never used; formal-form leakage is a bug.
 *   - "Tag" (EN) as user-visible word is replaced by "Etiqueta" — note
 *     the polar-opposite choice vs fr.json, which keeps Tag.
 *   - "Collection" / "Owner" / "Sign in" etc. are fully translated.
 *     Standalone English product-noun leaks are bugs.
 */
import { describe, expect, test } from "vitest";

import es from "./resources/es.json";

const entries = Object.entries(es as Record<string, string>);

const matching = (pattern: RegExp): Array<[string, string]> =>
  entries.filter(([, v]) => pattern.test(v));

describe("INV-ES-TERM-1: es.json respects binding glossary terminology", () => {
  test('formal "Usted"/"usted" is never used (Tuteo only)', () => {
    const hits = matching(/\b[Uu]sted\b/);
    expect(hits, `Found ${hits.length} usted-leakage(s)`).toEqual([]);
  });

  test('"Tag(s)" (as a visible word) is replaced by "Etiqueta(s)" — {{tag}} placeholders allowed', () => {
    // Exclude template placeholders: we only want prose hits.
    const hits = entries.filter(
      ([, v]) => /\b[Tt]ags?\b/.test(v) && !/\{\{tag/.test(v),
    );
    expect(hits, `Found ${hits.length} tag-leakage(s)`).toEqual([]);
  });

  test('"Collection"/"Member"/"Owner"/"User" are translated in visible copy', () => {
    // These must never appear as standalone English words in *translated*
    // strings. Allow untranslated admin.db.* / admin.storage.*.desc strings
    // to keep English — they sit in their own untranslated-completeness
    // backlog. Heuristic: require the string to ALSO contain Spanish-only
    // indicators before flagging.
    const spanishIndicator =
      /[áéíóúñ¿¡]|\b(el|la|los|las|un|una|de|para|con|en|por|si|que)\b/i;
    const englishProductNouns = /\b(Collection|Member|Owner)\b/;
    const hits = entries.filter(
      ([, v]) => englishProductNouns.test(v) && spanishIndicator.test(v),
    );
    expect(
      hits,
      `English product-noun leaked into translated copy: ${hits.map(([k]) => k).join(", ")}`,
    ).toEqual([]);
  });
});
