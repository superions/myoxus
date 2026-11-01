/**
 * Configure dayjs locale and week start.
 *
 * Persistence and server-default resolution belong to UserPreferencesService.
 * This module only projects an already resolved value into dayjs.
 *
 * Hierarchy for locale (weekday names):
 * 1. Browser language (navigator.language)
 * 2. 'en' fallback
 */
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import localeData from "dayjs/plugin/localeData";
import updateLocale from "dayjs/plugin/updateLocale";

dayjs.extend(updateLocale);
dayjs.extend(isoWeek);
dayjs.extend(localeData);

let currentWeekStart: 0 | 1 = 1; // default Monday until overridden

// ── Step 1: Set locale for weekday names ─────────────────────────────
// Synchronous: set locale from browser language so weekday names are
// localized immediately (before any component renders).  dayjs silently
// falls back to 'en' if the locale is not registered yet.
const browserLang =
  (typeof navigator !== "undefined" && navigator.language) || "en";
const langCode = browserLang.toLowerCase(); // e.g. 'de', 'en-gb'
const langShort = langCode.split("-")[0]; // e.g. 'de', 'en'

// Try full tag first (en-gb), then short code (de).
dayjs.locale(langCode) || dayjs.locale(langShort);

// Async import for locales not yet bundled — re-applies after load.
if (langShort !== "en") {
  import(`dayjs/locale/${langShort}.js`)
    .then(() => {
      dayjs.locale(langShort);
      // Re-apply weekStart after locale change (locale may override it)
      dayjs.updateLocale(dayjs.locale(), { weekStart: currentWeekStart });
    })
    .catch(() => {
      /* locale not available */
    });
}

// ── Public API ───────────────────────────────────────────────────────

export function setFirstDayOfWeek(day: string) {
  const weekStart = day === "sunday" ? 0 : 1;
  currentWeekStart = weekStart as 0 | 1;
  dayjs.updateLocale(dayjs.locale(), { weekStart });
}

export function getFirstDayOfWeek(): 0 | 1 {
  return currentWeekStart;
}

export function getISOWeekNumber(date: dayjs.Dayjs): number {
  return (date as any).isoWeek();
}

// ── Timezone projection ──────────────────────────────────────────────

function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

let currentTimezone = getSystemTimezone();

export function getEffectiveTimezone(): string {
  return currentTimezone;
}

export function setTimezone(tz: string) {
  try {
    const resolved = tz === "auto" ? getSystemTimezone() : tz;
    Intl.DateTimeFormat(undefined, { timeZone: resolved });
    currentTimezone = resolved;
  } catch {
    /* invalid IANA zone — ignore */
  }
}
