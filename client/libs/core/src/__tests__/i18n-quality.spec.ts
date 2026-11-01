/**
 * @vitest-environment node
 */
/**
 * Translation quality guard tests.
 *
 * Invariants:
 *   inv_i18n_quality_json_syntax          — all registered locale files parse as valid JSON
 *   inv_i18n_quality_de_no_pseudo_umlauts_web   — no ue/oe/ae stand-ins in DE web keys
 *   inv_i18n_quality_de_no_pseudo_umlauts_admin — no ue/oe/ae stand-ins in DE admin keys
 *   inv_i18n_quality_fr_no_missing_accents — common French verbs have correct accents
 *   inv_i18n_quality_es_no_missing_accents — common Spanish words have correct accents
 *
 * These tests are regression guards: they MUST fail if a pseudo-umlaut or missing accent
 * is introduced. Verified by manual injection of a known bug before committing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

const BASE = "../../../i18n/src/resources";
const RESOURCE_DIR_REPO = "client/libs/i18n/src/resources";

async function loadLocale(lang: string): Promise<Record<string, string>> {
  const m = await import(`${BASE}/${lang}.json`);
  return (m.default ?? m) as Record<string, string>;
}

// All registered locale codes (matching SUPPORTED_LANGUAGES in index.ts)
const ALL_REGISTERED = [
  "en",
  "ko",
  "pt-BR",
  "zh-Hans",
  "zh-Hant",
  "fr",
  "es",
  "es-AR",
  "es-CL",
  "pl",
  "de",
  "ru",
  "ja",
  "it",
  "ca",
  "da",
  "hi",
  "sv-SE",
  "ur",
  "ar",
  "fa",
  "uk",
  "nb-NO",
  "el-GR",
];

/** Existing Database translations retain product-name and language-quality checks. */
const DATABASE_QUALITY_LOCALES = [
  "de",
  "fr",
  "es",
  "pl",
  "uk",
  "it",
  "ru",
  "ca",
  "sv-SE",
  "nb-NO",
  "pt-BR",
  "es-AR",
  "es-CL",
  "cs",
  "nl",
  "el-GR",
  "hu",
  "sk",
  "ro",
  "hr",
  "sr",
] as const;

const DATABASE_TIER_ONE_LOCALES = ["de", "fr", "es"] as const;
const DATABASE_VISIBLE_PREFIXES = [
  "com.myoxus.database.",
  "com.myoxus.workspace-import.",
] as const;

/**
 * Words that identify an untranslated English UI fragment without rejecting
 * shared product terms such as CSV, Kanban, URL, Format or Relation.
 */
const ENGLISH_UI_FALLBACK_PATTERN =
  /\b(the|this|that|these|your|you|cannot|could|will|before|after|until|when|then|again|choose|create|creating|created|delete|deleted|download|failed|imported|importing|open|preview|search|selected|uploading|workspace|rows?|fields?|views?|database|snapshot|unsupported|loading|target|reorder|resize|detected|dependencies|references|result|current|queued|pending|stale)\b/i;

// ---------------------------------------------------------------------------
// JSON syntax — all locale files must be importable (invalid JSON = import error)
// ---------------------------------------------------------------------------
describe("i18n quality — JSON syntax", () => {
  for (const lang of ALL_REGISTERED) {
    test(`inv_i18n_quality_json_syntax_${lang.replace(/[-]/g, "_")}`, async () => {
      // If the JSON is invalid, the import itself will throw — that IS the assertion.
      const m = await import(`${BASE}/${lang}.json`);
      const data = m.default ?? m;
      expect(typeof data).toBe("object");
      expect(data).not.toBeNull();
      expect(Object.keys(data as object).length).toBeGreaterThan(0);
    });
  }
});

describe("i18n quality — Database product names", () => {
  test("Notion remains a product name in existing Database translations", async () => {
    const en = await loadLocale("en");
    const notionKeys = Object.entries(en)
      .filter(
        ([key, value]) =>
          key.startsWith("com.myoxus.database.") && value.includes("Notion"),
      )
      .map(([key]) => key);

    for (const locale of DATABASE_QUALITY_LOCALES) {
      const resource = await loadLocale(locale);
      const translatedProductNames = notionKeys.filter(
        (key) => key in resource && !resource[key].includes("Notion"),
      );
      expect(
        translatedProductNames,
        `${locale} translated or omitted the Notion product name`,
      ).toEqual([]);
    }
  });

  test("Database import diagnostics do not fall back to English sentences", async () => {
    const en = await loadLocale("en");
    const localizedSentenceKeys = [
      "com.myoxus.database.json-import.snapshot-exporter",
      "com.myoxus.database.json-import.snapshot-exported-at",
      "com.myoxus.database.notion-import.diagnostics.MIX_DATABASE_NOTION_ROLLUP_IMPORTED",
    ];

    for (const locale of DATABASE_QUALITY_LOCALES) {
      const resource = await loadLocale(locale);
      const englishFallbacks = localizedSentenceKeys.filter(
        (key) => resource[key] === en[key],
      );
      expect(
        englishFallbacks,
        `${locale} contains English Database import sentence fallbacks`,
      ).toEqual([]);
    }
  });

  test("Tier-1 Database surfaces do not contain obvious English fallbacks", async () => {
    const en = await loadLocale("en");

    for (const locale of DATABASE_TIER_ONE_LOCALES) {
      const resource = await loadLocale(locale);
      const englishFallbacks = Object.entries(en)
        .filter(([key]) =>
          DATABASE_VISIBLE_PREFIXES.some((prefix) => key.startsWith(prefix)),
        )
        .filter(([, value]) => !value.includes("$t("))
        .filter(([key, value]) => resource[key] === value)
        .filter(([, value]) =>
          ENGLISH_UI_FALLBACK_PATTERN.test(value.replace(/\{\{[^}]+\}\}/g, "")),
        )
        .map(([key, value]) => `${key}: ${value}`);

      expect(
        englishFallbacks,
        `${locale} contains obvious English Database UI fallbacks`,
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// DE — pseudo-umlaut detection
//
// Pattern: common German words where ue/oe/ae substitutes a real umlaut.
// This guard extends P107-T09 (which only covered admin.* keys) to ALL de.json keys.
// ---------------------------------------------------------------------------

/** Words where ue/oe/ae is a pseudo-umlaut stand-in (not etymologically correct). */
const DE_PSEUDO_UMLAUT_PATTERN =
  /\b(loesch|oeffen|uebers|dafuer\b|darueber|darunter\b|zurueck|Aender|aender|Bestaet|bestaet|veroeffe|verfueg|waehl|schliess|moegl|hinzufueg|Loeschen|loeschen|Schliessen|schliessen|Oeffnen|oeffnen|Zurueck\b|Bestaetig|Ueberp|ueberp|Naechst|naechst|Taeglich|taeglich|Woechentl|woechentl|Stuendl|stuendl|Veroeffentl|veroeffentl|Schluessel|schluessel)/i;

describe("i18n quality — DE pseudo-umlaut guard", () => {
  test("inv_i18n_quality_de_no_pseudo_umlauts_web", async () => {
    const de = await loadLocale("de");
    const bugs = Object.entries(de)
      .filter(([k]) => !k.startsWith("admin."))
      .filter(([, v]) => DE_PSEUDO_UMLAUT_PATTERN.test(v));
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      `DE web keys with pseudo-umlauts (${bugs.length} found)`,
    ).toEqual([]);
  });

  test("inv_i18n_quality_de_no_pseudo_umlauts_admin", async () => {
    const de = await loadLocale("de");
    const bugs = Object.entries(de)
      .filter(([k]) => k.startsWith("admin."))
      .filter(([, v]) => DE_PSEUDO_UMLAUT_PATTERN.test(v));
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      `DE admin keys with pseudo-umlauts (${bugs.length} found)`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FR — missing accent detection
//
// Common French verbs and words that MUST contain an accent.
// Pattern: word without any accent character where one is required.
// ---------------------------------------------------------------------------

describe("i18n quality — FR accent guard", () => {
  test("inv_i18n_quality_fr_deja_has_accent", async () => {
    const fr = await loadLocale("fr");
    // "deja" without accent where "déjà" is expected
    const bugs = Object.entries(fr).filter(
      ([, v]) => /\bdeja\b/i.test(v) && !/\bdéjà\b/i.test(v),
    );
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      'FR keys using "deja" instead of "déjà"',
    ).toEqual([]);
  });

  test("inv_i18n_quality_fr_gerer_has_accent", async () => {
    const fr = await loadLocale("fr");
    const bugs = Object.entries(fr).filter(
      ([, v]) => /\bgerer\b/i.test(v) && !/\bgérer\b/i.test(v),
    );
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      'FR keys using "gerer" instead of "gérer"',
    ).toEqual([]);
  });

  test("inv_i18n_quality_fr_creer_has_accent", async () => {
    const fr = await loadLocale("fr");
    const bugs = Object.entries(fr).filter(
      ([, v]) => /\bcreer\b/i.test(v) && !/\bcréer\b/i.test(v),
    );
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      'FR keys using "creer" instead of "créer"',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ES — missing accent detection
// ---------------------------------------------------------------------------
describe("i18n quality — ES accent guard", () => {
  test("inv_i18n_quality_es_crear_no_wrong_form", async () => {
    const es = await loadLocale("es");
    // "crear" is correct in Spanish (no accent) — but "creacion" without accent is wrong
    const bugs = Object.entries(es).filter(
      ([, v]) => /\bcreacion\b/i.test(v) && !/\bcreación\b/i.test(v),
    );
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      'ES keys using "creacion" instead of "creación"',
    ).toEqual([]);
  });

  test("inv_i18n_quality_es_configuracion_has_accent", async () => {
    const es = await loadLocale("es");
    const bugs = Object.entries(es).filter(
      ([, v]) => /\bconfiguracion\b/i.test(v) && !/\bconfiguración\b/i.test(v),
    );
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      'ES keys using "configuracion" instead of "configuración"',
    ).toEqual([]);
  });

  test("inv_i18n_quality_es_eliminacion_has_accent", async () => {
    const es = await loadLocale("es");
    const bugs = Object.entries(es).filter(
      ([, v]) => /\beliminacion\b/i.test(v) && !/\beliminación\b/i.test(v),
    );
    expect(
      bugs.map(([k, v]) => `${k}: ${v.slice(0, 60)}`),
      'ES keys using "eliminacion" instead of "eliminación"',
    ).toEqual([]);
  });
});

const COMMON_CALENDAR_KEYS = [
  "com.myoxus.common.calendar.month-names",
  "com.myoxus.common.calendar.today",
  "com.myoxus.common.calendar.week-days",
  "com.myoxus.common.calendar.show-weeks",
  "com.myoxus.common.calendar.show-weeks.desc",
  "com.myoxus.common.week.first-day",
  "com.myoxus.common.week.first-day.desc",
  "com.myoxus.common.week.monday",
  "com.myoxus.common.week.sunday",
] as const;

const LEGACY_COMMON_I18N_KEYS = [
  "admin.system.field.first-day-of-week.desc",
  "com.myoxus.calendar-date-picker.month-names",
  "com.myoxus.calendar-date-picker.today",
  "com.myoxus.calendar-date-picker.week-days",
  "com.myoxus.settings.journal.first-day-of-week",
  "com.myoxus.settings.journal.first-day-of-week.desc",
  "com.myoxus.settings.journal.first-day-of-week.monday",
  "com.myoxus.settings.journal.first-day-of-week.sunday",
  "com.myoxus.settings.journal.show-calendar-weeks",
  "com.myoxus.settings.journal.show-calendar-weeks.desc",
] as const;

const COMMON_CALENDAR_EXPECTED = {
  de: {
    "com.myoxus.common.calendar.month-names":
      "Jan,Feb,Mär,Apr,Mai,Jun,Jul,Aug,Sep,Okt,Nov,Dez",
    "com.myoxus.common.calendar.today": "Heute",
    "com.myoxus.common.calendar.week-days": "So,Mo,Di,Mi,Do,Fr,Sa",
    "com.myoxus.common.calendar.show-weeks": "Kalenderwochen anzeigen",
    "com.myoxus.common.calendar.show-weeks.desc":
      "Zeigt ISO-Wochennummern (KW) in der Monatsansicht an.",
    "com.myoxus.common.week.first-day": "Erster Wochentag",
    "com.myoxus.common.week.first-day.desc":
      "Lege fest, ob die Woche am Montag (ISO) oder Sonntag (US) beginnt.",
    "com.myoxus.common.week.monday": "Montag",
    "com.myoxus.common.week.sunday": "Sonntag",
  },
  fr: {
    "com.myoxus.common.calendar.month-names":
      "Jan,Fév,Mar,Avr,Mai,Juin,Juil,Août,Sep,Oct,Nov,Déc",
    "com.myoxus.common.calendar.today": "Aujourd’hui",
    "com.myoxus.common.calendar.week-days": "Dim,Lun,Mar,Mer,Jeu,Ven,Sam",
    "com.myoxus.common.calendar.show-weeks": "Afficher les numéros de semaine",
    "com.myoxus.common.calendar.show-weeks.desc":
      "Afficher les numéros de semaine ISO dans la vue mensuelle.",
    "com.myoxus.common.week.first-day": "Premier jour de la semaine",
    "com.myoxus.common.week.first-day.desc":
      "Choisissez si la semaine commence le lundi (ISO) ou le dimanche (US).",
    "com.myoxus.common.week.monday": "Lundi",
    "com.myoxus.common.week.sunday": "Dimanche",
  },
  es: {
    "com.myoxus.common.calendar.month-names":
      "Ene,Feb,Mar,Abr,May,Jun,Jul,Ago,Sep,Oct,Nov,Dic",
    "com.myoxus.common.calendar.today": "Hoy",
    "com.myoxus.common.calendar.week-days": "Dom,Lun,Mar,Mié,Jue,Vie,Sáb",
    "com.myoxus.common.calendar.show-weeks": "Mostrar semanas del calendario",
    "com.myoxus.common.calendar.show-weeks.desc":
      "Muestra los números de semana ISO en la vista mensual.",
    "com.myoxus.common.week.first-day": "Primer día de la semana",
    "com.myoxus.common.week.first-day.desc":
      "Elige si la semana empieza el lunes (ISO) o el domingo (US).",
    "com.myoxus.common.week.monday": "Lunes",
    "com.myoxus.common.week.sunday": "Domingo",
  },
  it: {
    "com.myoxus.common.calendar.month-names":
      "Gen,Feb,Mar,Apr,Mag,Giu,Lug,Ago,Set,Ott,Nov,Dic",
    "com.myoxus.common.calendar.today": "Oggi",
    "com.myoxus.common.calendar.week-days": "Dom,Lun,Mar,Mer,Gio,Ven,Sab",
    "com.myoxus.common.calendar.show-weeks": "Mostra settimane del calendario",
    "com.myoxus.common.calendar.show-weeks.desc":
      "Visualizza i numeri di settimana ISO nella vista mensile.",
    "com.myoxus.common.week.first-day": "Primo giorno della settimana",
    "com.myoxus.common.week.first-day.desc":
      "Scegli se la settimana inizia il lunedì (ISO) o la domenica (US).",
    "com.myoxus.common.week.monday": "Lunedì",
    "com.myoxus.common.week.sunday": "Domenica",
  },
} as const;

describe("i18n quality — common namespace consolidation guards", () => {
  test("common calendar/week keys are localized in Tier-1 plus Italian", async () => {
    for (const [lang, expected] of Object.entries(COMMON_CALENDAR_EXPECTED)) {
      const loc = await loadLocale(lang);
      for (const key of COMMON_CALENDAR_KEYS) {
        expect(
          loc[key],
          `${lang}.${key} must be localized and must not fall back to English`,
        ).toBe(expected[key]);
      }
    }
  });

  test("legacy calendar/week duplicate keys are absent from locale resources", () => {
    const resourceDir = join(process.cwd(), RESOURCE_DIR_REPO);
    const offenders = readdirSync(resourceDir)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        const data = JSON.parse(
          readFileSync(join(resourceDir, file), "utf8"),
        ) as Record<string, string>;
        return LEGACY_COMMON_I18N_KEYS.filter((key) => key in data).map(
          (key) => `${file}: ${key}`,
        );
      });

    expect(offenders).toEqual([]);
  });
});

const FRONTEND_LOCALE_SOURCE_ROOTS = [
  "client/admin/workspaces/admin/src",
  "client/libs/core/src",
  "client/libs/ui-facade/src",
  "client/web/workspaces",
  "client/apps/electron-renderer",
] as const;

const FRONTEND_LOCALE_ALLOWED_FILES = new Set([
  // The template preview endpoint still requests an explicit fixture locale.
  // User-facing formatting must use active i18n language instead.
  "client/admin/workspaces/admin/src/modules/pdf-export/api.ts",
  "client/admin/workspaces/admin/src/modules/pdf-export/components/template-detail-drawer.tsx",
]);

const FRONTEND_LOCALE_FORBIDDEN = [
  {
    pattern:
      /new\s+Intl\.(?:DateTimeFormat|NumberFormat)\(\s*["'`](?:en-US|de-DE)["'`]/g,
    label: "hardcoded Intl formatter locale",
  },
  {
    pattern: /\.toLocale(?:DateString|TimeString|String)\(\s*(?:\)|["'`])/g,
    label: "implicit or hardcoded toLocale formatter",
  },
] as const;

function collectFrontendSourceFiles(root: string): string[] {
  const absolute = join(process.cwd(), root);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const entries = readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolutePath = join(absolute, entry.name);
    const repoPath = relative(process.cwd(), absolutePath);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "coverage"
      ) {
        return [];
      }
      return collectFrontendSourceFiles(repoPath);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) {
      return [];
    }
    if (/\.(?:spec|test|stories)\.(?:ts|tsx)$/.test(entry.name)) {
      return [];
    }
    if (entry.name.endsWith(".d.ts")) {
      return [];
    }
    return [repoPath];
  });
}

describe("i18n quality — common namespace source guards", () => {
  test("active frontend source uses common calendar/week keys", () => {
    const offenders = FRONTEND_LOCALE_SOURCE_ROOTS.flatMap((root) =>
      collectFrontendSourceFiles(root),
    ).flatMap((repoPath) => {
      const source = readFileSync(join(process.cwd(), repoPath), "utf8");
      return LEGACY_COMMON_I18N_KEYS.flatMap((key) => {
        const index = source.indexOf(key);
        if (index === -1) {
          return [];
        }
        const line = source.slice(0, index).split(/\r?\n/).length || 1;
        return `${repoPath}:${line}: legacy i18n key ${key}`;
      });
    });

    expect(offenders).toEqual([]);
  });
});

describe("i18n quality — frontend locale formatting guard", () => {
  test("frontend source does not hardcode user-visible date or number locales", () => {
    const offenders = FRONTEND_LOCALE_SOURCE_ROOTS.flatMap((root) =>
      collectFrontendSourceFiles(root),
    ).flatMap((repoPath) => {
      if (FRONTEND_LOCALE_ALLOWED_FILES.has(repoPath)) {
        return [];
      }
      const source = readFileSync(join(process.cwd(), repoPath), "utf8");
      return FRONTEND_LOCALE_FORBIDDEN.flatMap(({ pattern, label }) => {
        pattern.lastIndex = 0;
        return Array.from(source.matchAll(pattern)).map((match) => {
          const line =
            source.slice(0, match.index ?? 0).split(/\r?\n/).length || 1;
          return `${repoPath}:${line}: ${label}: ${match[0]}`;
        });
      });
    });

    expect(offenders).toEqual([]);
  });
});
