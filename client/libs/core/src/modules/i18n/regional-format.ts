// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export type DateFormatPreference =
  "locale" | "day-month-year" | "month-day-year" | "year-month-day";

export type TimeFormatPreference = "locale" | "12-hour" | "24-hour";

export function normalizeDateFormatPreference(
  value: string | null | undefined,
): DateFormatPreference {
  switch (value) {
    case "day-month-year":
    case "month-day-year":
    case "year-month-day":
      return value;
    default:
      return "locale";
  }
}

export function normalizeTimeFormatPreference(
  value: string | null | undefined,
): TimeFormatPreference {
  return value === "12-hour" || value === "24-hour" ? value : "locale";
}

export type RegionalFormatPreferences = {
  locale: string;
  timezone: string;
  dateFormat: DateFormatPreference;
  timeFormat: TimeFormatPreference;
};

export type DateInput = Date | number | string;

function asDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function isValidDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function numericDateParts(
  value: DateInput,
  preferences: RegionalFormatPreferences,
) {
  const parts = new Intl.DateTimeFormat(preferences.locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: preferences.timezone,
  }).formatToParts(asDate(value));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return { day: read("day"), month: read("month"), year: read("year") };
}

export function formatRegionalDate(
  value: DateInput,
  preferences: RegionalFormatPreferences,
): string {
  const date = asDate(value);
  if (!isValidDate(date)) return String(value);
  if (preferences.dateFormat === "locale") {
    return new Intl.DateTimeFormat(preferences.locale, {
      dateStyle: "medium",
      timeZone: preferences.timezone,
    }).format(date);
  }

  const { day, month, year } = numericDateParts(date, preferences);
  switch (preferences.dateFormat) {
    case "day-month-year":
      return `${day}.${month}.${year}`;
    case "month-day-year":
      return `${month}/${day}/${year}`;
    case "year-month-day":
      return `${year}-${month}-${day}`;
  }
}

export function formatRegionalTime(
  value: DateInput,
  preferences: RegionalFormatPreferences,
): string {
  const date = asDate(value);
  if (!isValidDate(date)) return String(value);
  return new Intl.DateTimeFormat(preferences.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12:
      preferences.timeFormat === "locale"
        ? undefined
        : preferences.timeFormat === "12-hour",
    timeZone: preferences.timezone,
  }).format(date);
}

export function formatRegionalDateTime(
  value: DateInput,
  preferences: RegionalFormatPreferences,
): string {
  const date = asDate(value);
  if (!isValidDate(date)) return String(value);
  return `${formatRegionalDate(date, preferences)}, ${formatRegionalTime(
    date,
    preferences,
  )}`;
}
