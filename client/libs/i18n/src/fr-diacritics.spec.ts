/**
 * INV-FR-DIAC-1: High-frequency French words missing their diacritics.
 *                Bare "ete" instead of "été", "tres" instead of "très",
 *                "parametres" instead of "paramètres", "Echec" instead
 *                of "Échec", etc. are all treated as translation bugs.
 *
 * The list below is the post-P123-B-01 baseline: zero occurrences in
 * fr.json. If CI ever reports >0 for any of these, a translation has
 * regressed and must be corrected.
 */
import { describe, expect, test } from "vitest";

import fr from "./resources/fr.json";

const values = Object.values(fr as Record<string, string>);

const countMatches = (pattern: RegExp): string[] =>
  values.filter((v) => pattern.test(v));

// Each entry: label + regex that MUST NOT match.
const guards: Array<[string, RegExp]> = [
  ["Etes/etes (→ Êtes/êtes)", /\bEtes\b|n'etes\b/],
  ["Apres/apres (→ Après/après)", /\bApres\b|\bapres\b/],
  ["a ete (→ a été)", /\ba ete\b/],
  // `\b` in JS treats accented chars as word-boundaries, so "paramètres" would
  // match `\btres\b`. Require an ASCII-letter-free preceding context.
  ["tres (→ très)", /(?:^|[^A-Za-z\u00C0-\u024F])tres\b/],
  ["deja (→ déjà)", /(?:^|[^A-Za-z\u00C0-\u024F])deja\b/],
  ["Echec/echec (→ Échec)", /\bEchec\b|(?<=[^\w])echec\b/],
  ["parametres (→ paramètres)", /\bparametres\b|\bParametres\b/],
  ["systeme (→ système)", /\bSysteme\b|\bsysteme\b/],
  ["acces (→ accès)", /\bacces\b|\bAcces\b/],
  ["succes (→ succès)", /\bsucces\b/],
  ["irreversible (→ irréversible)", /\birreversible\b/],
  ["definitivement (→ définitivement)", /\bdefinitivement\b/],
  ["egalement (→ également)", /\begalement\b/],
  ["creation (→ création)", /\bCreation\b|\bcreation\b/],
  ["theme (→ thème)", /\btheme\b/],
  ["defaut (→ défaut)", /\bpar defaut\b/],
  ["metadonnees (→ métadonnées)", /\bmetadonnees\b/],
  ["verification (→ vérification)", /\bverification\b/],
  ["equipe (→ équipe)", /\bl'equipe\b|\bL'equipe\b/],
  ["pret a (→ prêt à)", /\bpret a\b/],
  [
    "<auxiliary> etre (→ être)",
    /\bpourra etre\b|\bpeut etre\b|\bdoit etre\b|\bplus etre\b/,
  ],
  ["opération misspelled in header name", /x-opération/],
];

describe("INV-FR-DIAC-1: fr.json is free of pseudo-diacritic bugs", () => {
  test.each(guards)("%s", (_label, pattern) => {
    const hits = countMatches(pattern);
    expect(hits, `${hits.length} string(s) still missing diacritics`).toEqual(
      [],
    );
  });
});
