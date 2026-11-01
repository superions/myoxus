/**
 * INV-DE-PSEUDO-UMLAUT-1: de.json web-facing keys do not use ASCII
 *                          pseudo-umlauts (ae/oe/ue/ss) where a real
 *                          ä/ö/ü/ß is required.
 *
 * "Web-facing" here means keys that do NOT start with `admin.` —
 * admin.* is an enterprise-admin surface with its own review track
 * (P123-A track), so excluding it keeps this guard crisp.
 *
 * Each pattern matches a known German root that is consistently
 * written with an umlaut in correct de-DE copy. If any of these ever
 * hit >0 occurrences on web keys, a translation has regressed to a
 * pseudo-umlaut spelling and must be corrected.
 */
import { describe, expect, test } from "vitest";

import de from "./resources/de.json";

const webEntries = Object.entries(de as Record<string, string>).filter(
  ([k]) => !k.startsWith("admin."),
);

const matching = (pattern: RegExp): Array<[string, string]> =>
  webEntries.filter(([, v]) => pattern.test(v));

const guards: Array<[string, RegExp]> = [
  ["loeschen (→ löschen)", /\bloesch\w*/],
  ["oeffnen (→ öffnen)", /\boeffn\w*/],
  ["fuer (→ für)", /\b[Ff]uer\b/],
  ["dafuer (→ dafür)", /\b[Dd]afuer\b/],
  ["darueber (→ darüber)", /\bdarueber\b/],
  ["rueck* (→ rück*)", /\b[Rr]ueck\w*/],
  ["zurueck* (→ zurück*)", /\bzurueck\w*/],
  ["aender* (→ änder*)", /\b[Aa]ender\w*/],
  ["bestaet* (→ bestätig*)", /\b[Bb]estaet\w*/],
  ["veroeffent* (→ veröffentlich*)", /\bveroeffent\w*/],
  ["verknuep* (→ verknüpf*)", /\bverknuep\w*/],
  ["taetig* (→ tätig*)", /\b[Tt]aetig\w*/],
  ["moegl* (→ möglich*)", /\b[Mm]oegl\w*/],
  ["verfueg* (→ verfüg*)", /\b[Vv]erfueg\w*/],
  ["waehl* (→ wähl*)", /\b[Ww]aehl\w*/],
  ["ausfueh* (→ ausführ*)", /\bausfueh\w*/],
  ["durchfueh* (→ durchführ*)", /\bdurchfueh\w*/],
  ["hinzufueg* (→ hinzufüg*)", /\bhinzufueg\w*/],
  ["schliess* (→ schließ*, not Swiss)", /\bschliess\w*/],
  ["muess* (→ müss*)", /\b[Mm]uess\w*/],
  ["groess* (→ größ*)", /\b[Gg]roess\w*/],
];

describe("INV-DE-PSEUDO-UMLAUT-1: de.json web keys have no ASCII pseudo-umlauts", () => {
  test.each(guards)("%s", (_label, pattern) => {
    const hits = matching(pattern);
    expect(
      hits,
      `${hits.length} web-key(s) use pseudo-umlaut: ${hits.map(([k]) => k).join(", ")}`,
    ).toEqual([]);
  });
});
