import { fuzzyMatch } from "@myoxus/core/utils/fuzzy-match";
import { I18n } from "@myoxus/i18n";
import dayjs from "dayjs";

import { JOURNAL_DATE_FORMAT } from "./services/journal";

const ENGLISH_LANGUAGE = "en";

function preferredLanguages(language?: string): string[] {
  return Array.from(
    new Set([language || I18n.language, ENGLISH_LANGUAGE].filter(Boolean)),
  ) as string[];
}

function localizedMonthCandidates(language?: string) {
  return preferredLanguages(language).flatMap((locale) =>
    Array.from({ length: 12 }, (_, index) => ({
      index,
      name: new Intl.DateTimeFormat(locale, { month: "long" }).format(
        new Date(2024, index, 1),
      ),
    })),
  );
}

function localizedWeekdayName(dayIndex: number, language?: string): string {
  const locale = language || I18n.language || ENGLISH_LANGUAGE;
  return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(
    new Date(2024, 0, 7 + dayIndex),
  );
}

function matchesAnyCandidate(candidates: string[], query: string): boolean {
  return candidates.some((candidate) => fuzzyMatch(candidate, query, true));
}

export function suggestJournalDate(
  query: string,
  language = I18n.language,
): {
  dateString: string;
  alias?: string;
} | null {
  // given a query string, suggest a journal date
  // if the query is empty or, starts with "t" AND matches today
  //   -> suggest today's date
  // if the query starts with "y" AND matches "yesterday"
  //   -> suggest yesterday's date
  // if the query starts with "l" AND matches last
  //   -> suggest last week's date
  // if the query starts with "n" AND matches "next"
  //   -> suggest next week's date
  // if the query starts with the first letter of a month and matches the month name
  //   -> if the trailing part matches a number
  //      -> suggest the date of the month
  //      -> otherwise, suggest the current day of the month
  // otherwise, return null
  query = query.trim().toLowerCase().split(" ").join("");

  if (
    query === "" ||
    matchesAnyCandidate(["today", I18n.t("com.myoxus.today")], query)
  ) {
    return {
      dateString: dayjs().format(JOURNAL_DATE_FORMAT),
      alias: I18n.t("com.myoxus.today"),
    };
  }

  if (matchesAnyCandidate(["tomorrow", I18n.t("com.myoxus.tomorrow")], query)) {
    return {
      dateString: dayjs().add(1, "day").format(JOURNAL_DATE_FORMAT),
      alias: I18n.t("com.myoxus.tomorrow"),
    };
  }

  if (
    matchesAnyCandidate(["yesterday", I18n.t("com.myoxus.yesterday")], query)
  ) {
    return {
      dateString: dayjs().subtract(1, "day").format(JOURNAL_DATE_FORMAT),
      alias: I18n.t("com.myoxus.yesterday"),
    };
  }

  // next week dates, start from monday
  const nextWeekDates = Array.from({ length: 7 }, (_, index) =>
    dayjs()
      .add(1, "week")
      .startOf("week")
      .add(index, "day")
      .format(JOURNAL_DATE_FORMAT),
  ).map((date) => ({
    dateString: date,
    alias: I18n.t("com.myoxus.next-week", {
      weekday: localizedWeekdayName(dayjs(date).day(), language),
    }),
  }));

  const lastWeekDates = Array.from({ length: 7 }, (_, index) =>
    dayjs()
      .subtract(1, "week")
      .startOf("week")
      .add(index, "day")
      .format(JOURNAL_DATE_FORMAT),
  ).map((date) => ({
    dateString: date,
    alias: I18n.t("com.myoxus.last-week", {
      weekday: localizedWeekdayName(dayjs(date).day(), language),
    }),
  }));

  for (const date of [...nextWeekDates, ...lastWeekDates]) {
    const matched = fuzzyMatch(date.alias, query, true);
    if (matched) {
      return date;
    }
  }

  // if query is a string that starts with alphabet letters and/or numbers
  const regex = /^([\p{L}]+)(\d*)$/iu;
  const matched = query.match(regex);

  if (matched) {
    const [_, letters, numbers] = matched;

    for (const month of localizedMonthCandidates(language)) {
      const monthMatched = fuzzyMatch(month.name, letters, true);
      if (monthMatched) {
        let day = numbers ? parseInt(numbers) : dayjs().date();
        const invalidDay = day < 1 || day > 31;
        if (invalidDay) {
          // fallback to today's day
          day = dayjs().date();
        }
        const year = dayjs().year();
        return {
          dateString: dayjs(new Date(year, month.index, day)).format(
            JOURNAL_DATE_FORMAT,
          ),
        };
      }
    }
  }

  return null;
}
