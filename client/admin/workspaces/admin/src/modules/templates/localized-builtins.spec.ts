// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { TemplateSourceType, TemplateStatusType } from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import type { CatalogEntryViewModel } from "./format-adapters";
import {
  templateDisplayDescription,
  templateDisplayLabel,
  templateDisplayTags,
  templateDisplayTitle,
} from "./localized-builtins";

function i18nWith(values: Record<string, string>) {
  return {
    t: (key: string) => values[key] ?? key,
  };
}

function entry(
  overrides: Partial<CatalogEntryViewModel> = {},
): CatalogEntryViewModel {
  return {
    id: "tpl-1",
    slug: "business-daily",
    title: "Business Daily",
    description: "Daily business planning with priorities and follow-ups",
    category: "journal-daily",
    tags: ["daily", "planning", "business"],
    status: TemplateStatusType.Active,
    source: TemplateSourceType.Builtin,
    minClientVersion: 0,
    createdAt: "2026-05-20T00:00:00Z",
    updatedAt: "2026-05-20T00:00:00Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("localized builtin template display", () => {
  test("uses locale resources for builtin title, description and tags", () => {
    const i18n = i18nWith({
      "com.myoxus.journal.template.title.business-daily": "Tagesplan",
      "com.myoxus.journal.template.subtitle.business-daily":
        "Plane den Tag, bevor der Tag dich plant.",
      "admin.templates.tag.daily": "Täglich",
      "admin.templates.tag.planning": "Planung",
      "admin.templates.tag.business": "Geschäft",
    });
    const builtin = entry();

    expect(templateDisplayTitle(i18n, builtin)).toBe("Tagesplan");
    expect(templateDisplayDescription(i18n, builtin)).toBe(
      "Plane den Tag, bevor der Tag dich plant.",
    );
    expect(templateDisplayTags(i18n, builtin)).toEqual([
      "Täglich",
      "Planung",
      "Geschäft",
    ]);
    expect(templateDisplayLabel(i18n, builtin)).toBe(
      "Tagesplan (business-daily)",
    );
  });

  test("does not translate imported bundle metadata", () => {
    const i18n = i18nWith({
      "com.myoxus.journal.template.title.business-daily": "Tagesplan",
      "admin.templates.tag.daily": "Täglich",
    });
    const bundle = entry({
      source: TemplateSourceType.Bundle,
      title: "Business Daily",
      description: "Imported bundle copy",
    });

    expect(templateDisplayTitle(i18n, bundle)).toBe("Business Daily");
    expect(templateDisplayDescription(i18n, bundle)).toBe(
      "Imported bundle copy",
    );
    expect(templateDisplayTags(i18n, bundle)).toEqual([
      "daily",
      "planning",
      "business",
    ]);
  });
});
