/**
 * INV-FR-TERM-1: fr.json respects the binding French terminology from
 *                `docs/dev/clients/i18n-glossary.md` (P123-B-02).
 *
 * The dominant choices are locked in:
 *  - Étiquette / Libellé is never used — always "Tag" (product term).
 *  - Tutoiement (tu / tes / ton / ta) is never used — fr.json is
 *    strictly Vouvoiement (vous / votre / vos / Veuillez).
 *  - Standalone "Doc" (as a replacement for Document) is not used.
 */
import { describe, expect, test } from "vitest";

import fr from "./resources/fr.json";

const entries = Object.entries(fr as Record<string, string>);

const matching = (pattern: RegExp): Array<[string, string]> =>
  entries.filter(([, v]) => pattern.test(v));

describe("INV-FR-TERM-1: fr.json respects binding glossary terminology", () => {
  test('"Étiquette/Libellé" is never used — always "Tag"', () => {
    const hits = matching(/\b[ÉEé]tiquette|\bLibell[eé]/);
    expect(hits, `Found ${hits.length} Étiquette/Libellé-hits`).toEqual([]);
  });

  test('fr.json uses Vouvoiement exclusively — no "tu"/"tes"/"ton"/"ta"', () => {
    // French word-boundary: accented chars count as word chars, so `\btu\b`
    // would match inside "tué". Gate on ASCII-letter-free context.
    const boundary = String.raw`(?:^|[^A-Za-zÀ-ÿ])`;
    const tail = String.raw`(?![A-Za-zÀ-ÿ])`;
    const rx = new RegExp(`${boundary}(tu|tes|ton|ta|Tu|Tes|Ton|Ta)${tail}`);
    const hits = matching(rx);
    // Some admin.config.gitSync.* descriptions contain "tu" inside English
    // text ("status lookups") — those only appear if untranslated, and we
    // don't want to block untranslated strings here. Require that the
    // surrounding value has *any* French indicator to trigger.
    const frIndicator =
      /[éèêëàâùûüîïôœçÉÈÊÀÂÙÛÜÎÏÔŒÇ]|\b(de|le|la|un|une|des|les|du|votre|vous|pour|avec|dans)\b/i;
    const real = hits.filter(([, v]) => frIndicator.test(v));
    expect(
      real,
      `Tutoiement leaked into fr.json: ${real.map(([k]) => k).join(", ")}`,
    ).toEqual([]);
  });

  test('Standalone "Doc" is never used (Document/document only)', () => {
    const hits = matching(/\bDoc(s)?\b/);
    expect(hits, `Found ${hits.length} Doc-hits`).toEqual([]);
  });
});
