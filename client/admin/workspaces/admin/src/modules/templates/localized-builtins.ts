// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { TemplateSourceType } from "@myoxus/graphql";

type I18nLike = {
  t: (key: string, optionsOrDefault?: any, options?: any) => string;
};

type BuiltinMetadataKeys = {
  title: string;
  description: string;
};

const BUILTIN_METADATA_KEYS: Record<string, BuiltinMetadataKeys> = {
  "agile-retro": {
    title: "com.myoxus.journal.template.title.agile-retro",
    description: "com.myoxus.journal.template.subtitle.agile-retro",
  },
  "agile-standup": {
    title: "com.myoxus.journal.template.title.agile-standup",
    description: "com.myoxus.journal.template.subtitle.agile-standup",
  },
  "business-daily": {
    title: "com.myoxus.journal.template.title.business-daily",
    description: "com.myoxus.journal.template.subtitle.business-daily",
  },
  eisenhower: {
    title: "com.myoxus.journal.template.title.eisenhower",
    description: "com.myoxus.journal.template.subtitle.eisenhower",
  },
  "getting-started-myoxus": {
    title: "com.myoxus.onboarding.getting-started.title",
    description: "com.myoxus.onboarding.getting-started.subtitle",
  },
  "gtd-weekly-review": {
    title: "com.myoxus.journal.template.title.gtd-weekly-review",
    description: "com.myoxus.journal.template.subtitle.gtd-weekly-review",
  },
  "hybrid-day-sprint": {
    title: "com.myoxus.journal.template.title.hybrid",
    description: "com.myoxus.journal.template.subtitle.hybrid",
  },
  "meeting-notes": {
    title: "com.myoxus.journal.template.title.meeting-notes",
    description: "com.myoxus.journal.template.subtitle.meeting-notes",
  },
  "personal-journal": {
    title: "com.myoxus.journal.template.title.personal",
    description: "com.myoxus.journal.template.subtitle.personal",
  },
  "time-blocking": {
    title: "com.myoxus.journal.template.title.time-blocking",
    description: "com.myoxus.journal.template.subtitle.time-blocking",
  },
  "welcome-myoxus": {
    title: "com.myoxus.onboarding.welcome.title",
    description: "com.myoxus.onboarding.welcome.subtitle",
  },
};

function translateOrFallback(
  i18n: I18nLike,
  key: string | undefined,
  fallback: string | null | undefined,
) {
  if (!key) return fallback ?? null;
  const translated = i18n.t(key);
  return translated && translated !== key ? translated : (fallback ?? null);
}

function isBuiltin(entry: { source?: unknown }) {
  return String(entry.source) === TemplateSourceType.Builtin;
}

export function templateCatalogCardCode(entry: {
  source?: unknown;
  slug: string;
}) {
  return isBuiltin(entry) ? null : entry.slug;
}

export function templateDisplayTitle(
  i18n: I18nLike,
  entry: { source?: unknown; slug: string; title: string },
) {
  if (!isBuiltin(entry)) return entry.title;
  return (
    translateOrFallback(
      i18n,
      BUILTIN_METADATA_KEYS[entry.slug]?.title,
      entry.title,
    ) ?? entry.title
  );
}

export function templateDisplayDescription(
  i18n: I18nLike,
  entry: { source?: unknown; slug: string; description?: string | null },
) {
  if (!isBuiltin(entry)) return entry.description ?? null;
  return translateOrFallback(
    i18n,
    BUILTIN_METADATA_KEYS[entry.slug]?.description,
    entry.description,
  );
}

export function templateDisplayTags(
  i18n: I18nLike,
  entry: { source?: unknown; tags: string[] },
) {
  if (!isBuiltin(entry)) return entry.tags;
  return entry.tags.map((tag) => {
    const key = `admin.templates.tag.${tag}`;
    const translated = i18n.t(key);
    return translated && translated !== key ? translated : tag;
  });
}

export function templateDisplayLabel(
  i18n: I18nLike,
  entry: { source?: unknown; slug: string; title: string },
) {
  return `${templateDisplayTitle(i18n, entry)} (${entry.slug})`;
}

export function translateTemplateCategory(
  i18n: I18nLike,
  category: string | null | undefined,
) {
  if (!category) return "\u2014";
  if (category === "building-blocks") {
    return i18n.t("admin.templates.category.building-blocks");
  }
  const key = `admin.templates.category.${category}`;
  const translated = i18n.t(key);
  return translated && translated !== key ? translated : category;
}
