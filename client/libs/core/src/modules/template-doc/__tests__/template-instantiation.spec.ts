// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  buildTemplateVariables,
  optionalProjectTemplateVariableNames,
  optionalPreparationTemplateVariableNames,
  findUnresolvedTemplateVariables,
  replaceTemplateVariables,
  templateVariableRanges,
} from "../../doc/services/template-variables";
import { resolveTemplateDocumentTitle } from "../services/template-instantiation";

const germanPreferences = {
  locale: "de",
  timezone: "Europe/Berlin",
  dateFormat: "locale",
  timeFormat: "locale",
} as const;

describe("template instantiation contract", () => {
  test("creation context uses exact flat names without dotted aliases", () => {
    const source =
      "{{parent_page_title}} / {{folder_name}} / {{parent.page.title}} / {{folder.name}}";
    expect(
      replaceTemplateVariables(source, {
        parent_page_title: "Parent",
        folder_name: "Folder",
      }),
    ).toBe("Parent / Folder / {{parent.page.title}} / {{folder.name}}");
  });
  test("organization names use exact underscore spellings, not implicit aliases", () => {
    const source =
      "{{organization_name}} / {{organization_unit_name}} / {{organization.name}}";
    expect(findUnresolvedTemplateVariables(source)).toEqual([
      "organization.name",
      "organization_name",
      "organization_unit_name",
    ]);
    expect(
      replaceTemplateVariables(source, {
        organization_name: "Company",
        organization_unit_name: "Team",
      }),
    ).toBe("Company / Team / {{organization.name}}");
  });
  test("accepts dotted paths without aliases and replaces brace-bearing values only once", () => {
    expect(
      findUnresolvedTemplateVariables("{{ workspace.name }} {{creator.email}}"),
    ).toEqual(["creator.email", "workspace.name"]);
    expect(
      replaceTemplateVariables("{{workspace.name}} / {{creator.name}}", {
        "workspace.name": "Team {{creator.name}}",
        "creator.name": "Literal {{unknown}}",
      }),
    ).toBe("Team {{creator.name}} / Literal {{unknown}}");
    expect(
      replaceTemplateVariables("{{workspace_name}}", {
        "workspace.name": "Team",
      }),
    ).toBe("{{workspace_name}}");
  });

  test.each([
    "{{workspace..name}}",
    "{{.name}}",
    "{{workspace.}}",
    "{{}}",
    "{{workspace.name}",
    "{{{workspace.name}}}",
  ])("rejects malformed authored syntax %s", (value) => {
    expect(() => templateVariableRanges(value)).toThrow("invalid-syntax");
  });

  test("keeps a journal calendar date stable and localizes all date variables", () => {
    const variables = buildTemplateVariables("2026-07-15", germanPreferences);

    expect(variables).toMatchObject({
      date_long: "15. Juli 2026",
      iso: "2026-07-15",
      month: "Juli 2026",
      quarter: "Q3 2026",
      year: "2026",
    });
    expect(variables.week).toMatch(/^\d+$/);
  });

  test.each(["Pacific/Kiritimati"])(
    "ISO Journal year is stable in %s",
    (timezone) => {
      const values = buildTemplateVariables("2021-01-01", {
        ...germanPreferences,
        timezone,
      });
      expect(values).toMatchObject({
        iso: "2021-01-01",
        year: "2021",
        week: "53",
        "calendar.iso_week_year": "2020",
      });
    },
  );

  test.each([
    ["America/Los_Angeles", "53", "2020"],
    ["Pacific/Kiritimati", "1", "2021"],
  ])(
    "ISO instant week and year use the same effective day in %s",
    (timezone, week, year) => {
      const values = buildTemplateVariables("2021-01-04T00:30:00Z", {
        ...germanPreferences,
        timezone,
      });
      expect([values.week, values["calendar.iso_week_year"]]).toEqual([
        week,
        year,
      ]);
    },
  );

  test("resolves known variables and exposes unknown variables", () => {
    const resolved = replaceTemplateVariables(
      "{{weekday}}, {{date_long}} · {{unknown}}",
      { weekday: "Mittwoch", date_long: "15. Juli 2026" },
    );

    expect(resolved).toBe("Mittwoch, 15. Juli 2026 · {{unknown}}");
    expect(findUnresolvedTemplateVariables(resolved)).toEqual(["unknown"]);
  });

  test("moves the composed template title into the native document title", () => {
    expect(
      resolveTemplateDocumentTitle({
        sourceTitle: "Meeting-Notizen",
        dateLabel: "15. Juli 2026",
        titlePolicy: "template-date",
      }),
    ).toBe("Meeting-Notizen · 15. Juli 2026");
    expect(
      resolveTemplateDocumentTitle({
        sourceTitle: "Meeting-Notizen",
        dateLabel: "15. Juli 2026",
        titlePolicy: "preserve",
      }),
    ).toBeUndefined();
  });
});

test("optional Project scalars default to empty and explicit values remain literal", () => {
  const variables = buildTemplateVariables("2026-07-15", germanPreferences);
  expect(
    Object.fromEntries(
      optionalProjectTemplateVariableNames.map((name) => [
        name,
        variables[name],
      ]),
    ),
  ).toEqual({
    "project.title": "",
    "project.goal": "",
    "project.scope": "",
    "project.start_date": "",
    "project.end_date": "",
    "project.people": "",
  });
  const source = optionalProjectTemplateVariableNames
    .map((name) => `{{${name}}}`)
    .join(" | ");
  expect(replaceTemplateVariables(source, variables)).toBe(" |  |  |  |  | ");
  expect(
    replaceTemplateVariables(
      "{{project.title}} / {{project.goal}} / {{project.unknown}}",
      {
        ...variables,
        "project.title": "Atlas {{project.goal}}",
        "project.goal": "",
      },
    ),
  ).toBe("Atlas {{project.goal}} /  / {{project.unknown}}");
});

test("native preparation defaults are empty literals and never infer an application date", () => {
  const variables = buildTemplateVariables("2026-07-15", germanPreferences);
  expect(
    Object.fromEntries(
      optionalPreparationTemplateVariableNames.map((name) => [
        name,
        variables[name],
      ]),
    ),
  ).toEqual({
    "preparation.title": "",
    "preparation.date": "",
    "preparation.people": "",
    "preparation.notes": "",
  });
  expect(
    replaceTemplateVariables(
      "{{preparation.date}} / {{preparation.notes}} / {{preparation.unknown}}",
      variables,
    ),
  ).toBe(" /  / {{preparation.unknown}}");
});
