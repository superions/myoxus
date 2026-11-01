// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  editorMessage,
  type EditorI18nMessage,
  type MyoxusTemplateVariableCapability,
} from "@virgultum/shared/services";

import { formatRegionalDate, type RegionalFormatPreferences } from "../../i18n";
import { TemplateInstantiationError } from "../../template-doc/services/template-instantiation-error";

export type TemplateDateInput = Date | number | string;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEMPLATE_VARIABLE = /{{([^{}]*)}}/g;
const TEMPLATE_PATH = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/i;

const capability = (
  name: string,
  group: MyoxusTemplateVariableCapability["group"],
  label: EditorI18nMessage,
  source: EditorI18nMessage,
  availability: EditorI18nMessage,
): MyoxusTemplateVariableCapability => ({
  name,
  group,
  label,
  source,
  availability,
});

const allClients = editorMessage(
  "com.myoxus.editor.template-variable.availability.all",
  "Web and Electron",
);
const serverBacked = editorMessage(
  "com.myoxus.editor.template-variable.availability.server",
  "Server-backed documents",
);
const explicitContext = editorMessage(
  "com.myoxus.editor.template-variable.availability.context",
  "Explicit document context",
);
const creatorSource = editorMessage(
  "com.myoxus.editor.template-variable.source.document-creator",
  "Document creator",
);
const createdAtSource = editorMessage(
  "com.myoxus.editor.template-variable.source.document-creation-time",
  "Document creation time",
);
const workspaceSource = editorMessage(
  "com.myoxus.editor.template-variable.source.current-workspace",
  "Current workspace",
);
const organizationSource = editorMessage(
  "com.myoxus.editor.template-variable.source.workspace-organization",
  "Workspace organization",
);
const organizationUnitSource = editorMessage(
  "com.myoxus.editor.template-variable.source.workspace-organization-unit",
  "Workspace organization unit",
);
const dateSource = editorMessage(
  "com.myoxus.editor.template-variable.source.application-date",
  "Application date",
);
const actorSource = editorMessage(
  "com.myoxus.editor.template-variable.source.applying-account",
  "Authenticated applying account, not the document creator",
);

/** Optional literal setup context. Absence is empty, never a route lookup. */
export const optionalProjectTemplateVariableNames = [
  "project.title",
  "project.goal",
  "project.scope",
  "project.start_date",
  "project.end_date",
  "project.people",
] as const;

export const optionalProjectTemplateVariables = (): Record<string, string> =>
  Object.fromEntries(
    optionalProjectTemplateVariableNames.map((name) => [name, ""]),
  );

/** Explicit contextual preparation facts; ordinary copies leave them empty. */
export const optionalPreparationTemplateVariableNames = [
  "preparation.title",
  "preparation.date",
  "preparation.people",
  "preparation.notes",
] as const;

export const optionalPreparationTemplateVariables = (): Record<
  string,
  string
> =>
  Object.fromEntries(
    optionalPreparationTemplateVariableNames.map((name) => [name, ""]),
  );

const preparationSource = editorMessage(
  "com.myoxus.editor.template-variable.source.explicit-preparation",
  "Explicit preparation values; no inferred attendance or date",
);
const optionalPreparationContext = editorMessage(
  "com.myoxus.editor.template-variable.availability.optional-preparation-context",
  "Optional preparation context; empty when omitted",
);

const projectSource = editorMessage(
  "com.myoxus.editor.template-variable.source.explicit-project",
  "Explicit Project setup values, never inferred from the current location",
);
const optionalProjectContext = editorMessage(
  "com.myoxus.editor.template-variable.availability.optional-project-context",
  "Optional Project context; empty when omitted",
);

/**
 * The single authoring projection for scalar variables already resolved by
 * Core. Repeat-scoped `member.*` and collection values stay outside it.
 */
export const templateVariableCapabilities = [
  capability(
    "actor.name",
    "actor",
    editorMessage(
      "com.myoxus.editor.template-variable.actor.name.label",
      "Applying account name",
    ),
    actorSource,
    serverBacked,
  ),
  capability(
    "actor.email",
    "actor",
    editorMessage(
      "com.myoxus.editor.template-variable.actor.email.label",
      "Applying account email",
    ),
    actorSource,
    serverBacked,
  ),
  capability(
    "creator.name",
    "document",
    editorMessage(
      "com.myoxus.editor.template-variable.creator.name.label",
      "Creator name",
    ),
    creatorSource,
    serverBacked,
  ),
  capability(
    "creator.email",
    "document",
    editorMessage(
      "com.myoxus.editor.template-variable.creator.email.label",
      "Creator email",
    ),
    creatorSource,
    serverBacked,
  ),
  capability(
    "document.created_at.date",
    "document",
    editorMessage(
      "com.myoxus.editor.template-variable.document.created_at.date.label",
      "Created date",
    ),
    createdAtSource,
    serverBacked,
  ),
  capability(
    "document.created_at.time",
    "document",
    editorMessage(
      "com.myoxus.editor.template-variable.document.created_at.time.label",
      "Created time",
    ),
    createdAtSource,
    serverBacked,
  ),
  capability(
    "document.created_at.datetime",
    "document",
    editorMessage(
      "com.myoxus.editor.template-variable.document.created_at.datetime.label",
      "Created date and time",
    ),
    createdAtSource,
    serverBacked,
  ),
  capability(
    "workspace.name",
    "workspace",
    editorMessage(
      "com.myoxus.editor.template-variable.workspace.name.label",
      "Workspace name",
    ),
    workspaceSource,
    allClients,
  ),
  capability(
    "organization_name",
    "workspace",
    editorMessage(
      "com.myoxus.editor.template-variable.organization_name.label",
      "Organization name",
    ),
    organizationSource,
    serverBacked,
  ),
  capability(
    "organization_unit_name",
    "workspace",
    editorMessage(
      "com.myoxus.editor.template-variable.organization_unit_name.label",
      "Organization unit name",
    ),
    organizationUnitSource,
    serverBacked,
  ),
  ...(
    [
      ["date", editorMessage("Date", "Date")],
      [
        "date_long",
        editorMessage(
          "com.myoxus.editor.template-variable.date_long.label",
          "Long date",
        ),
      ],
      [
        "weekday",
        editorMessage(
          "com.myoxus.editor.template-variable.weekday.label",
          "Weekday",
        ),
      ],
      [
        "week",
        editorMessage(
          "com.myoxus.editor.template-variable.week.label",
          "ISO week",
        ),
      ],
      [
        "calendar.iso_week_year",
        editorMessage(
          "com.myoxus.editor.template-variable.calendar.iso_week_year.label",
          "ISO week year",
        ),
      ],
      [
        "month",
        editorMessage(
          "com.myoxus.editor.template-variable.month.label",
          "Month and year",
        ),
      ],
      [
        "quarter",
        editorMessage(
          "com.myoxus.editor.template-variable.quarter.label",
          "Quarter",
        ),
      ],
      [
        "year",
        editorMessage("com.myoxus.editor.template-variable.year.label", "Year"),
      ],
      [
        "iso",
        editorMessage(
          "com.myoxus.editor.template-variable.iso.label",
          "ISO date",
        ),
      ],
    ] as const
  ).map(([name, label]) =>
    capability(name, "date", label, dateSource, allClients),
  ),
  capability(
    "parent_page_title",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.parent_page_title.label",
      "Parent page title",
    ),
    editorMessage(
      "com.myoxus.editor.template-variable.source.explicit-parent-page",
      "Explicit parent page",
    ),
    explicitContext,
  ),
  capability(
    "folder_name",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.folder_name.label",
      "Folder name",
    ),
    editorMessage(
      "com.myoxus.editor.template-variable.source.explicit-destination-folder",
      "Explicit destination folder",
    ),
    explicitContext,
  ),
  capability(
    "folder.path",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.folder.path.label",
      "Folder path",
    ),
    editorMessage(
      "com.myoxus.editor.template-variable.source.explicit-destination-folder",
      "Explicit destination folder",
    ),
    explicitContext,
  ),
  capability(
    "project.title",
    "context",
    editorMessage("com.myoxus.database.create.project-name", "Project name"),
    projectSource,
    optionalProjectContext,
  ),
  capability(
    "project.goal",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.project.goal.label",
      "Project goal",
    ),
    projectSource,
    optionalProjectContext,
  ),
  capability(
    "project.scope",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.project.scope.label",
      "Project scope",
    ),
    projectSource,
    optionalProjectContext,
  ),
  capability(
    "project.start_date",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.project.start_date.label",
      "Project start date",
    ),
    projectSource,
    optionalProjectContext,
  ),
  capability(
    "project.end_date",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.project.end_date.label",
      "Project end date",
    ),
    projectSource,
    optionalProjectContext,
  ),
  capability(
    "project.people",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.project.people.label",
      "Project people",
    ),
    projectSource,
    optionalProjectContext,
  ),
  capability(
    "preparation.title",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.preparation.title.label",
      "Preparation title",
    ),
    preparationSource,
    optionalPreparationContext,
  ),
  capability(
    "preparation.date",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.preparation.date.label",
      "Preparation date",
    ),
    preparationSource,
    optionalPreparationContext,
  ),
  capability(
    "preparation.people",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.preparation.people.label",
      "Preparation people",
    ),
    preparationSource,
    optionalPreparationContext,
  ),
  capability(
    "preparation.notes",
    "context",
    editorMessage(
      "com.myoxus.editor.template-variable.preparation.notes.label",
      "Preparation notes",
    ),
    preparationSource,
    optionalPreparationContext,
  ),
] as const satisfies readonly MyoxusTemplateVariableCapability[];

/** Embedded delta values occupy one native offset even without printable text. */
export const templateDeltaText = (deltas: readonly { insert?: unknown }[]) =>
  deltas
    .map((delta) =>
      typeof delta.insert === "string" ? delta.insert : "\uFFFC",
    )
    .join("");

/** UTF-16 ranges match native Text offsets, including tokens split across marks. */
export function templateVariableRanges(
  value: string,
  onMalformed?: (start: number, length: number) => void,
) {
  const ranges: { start: number; length: number; name: string }[] = [];
  let end = 0;
  const malformed = (start: number, length: number) => {
    if (onMalformed) {
      onMalformed(start, length);
      return;
    }
    throw new TemplateInstantiationError("invalid-syntax", {
      range: { start, length },
    });
  };
  for (const match of value.matchAll(TEMPLATE_VARIABLE)) {
    const gap = /{{|}}/.exec(value.slice(end, match.index));
    if (gap) malformed(end + gap.index, 2);
    const name = match[1].trim();
    if (
      !TEMPLATE_PATH.test(name) ||
      value[match.index - 1] === "{" ||
      value[match.index + match[0].length] === "}"
    ) {
      malformed(match.index, match[0].length);
    } else ranges.push({ start: match.index, length: match[0].length, name });
    end = match.index + match[0].length;
  }
  const tail = /{{|}}/.exec(value.slice(end));
  if (tail) malformed(end + tail.index, 2);
  return ranges;
}

type NormalizedTemplateDate = {
  date: Date;
  preferences: RegionalFormatPreferences;
};

const normalizedTemplateDate = (
  value: TemplateDateInput,
  preferences: RegionalFormatPreferences,
): NormalizedTemplateDate => {
  const dateOnly = typeof value === "string" ? DATE_ONLY.exec(value) : null;
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return {
      date: new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day), 12),
      ),
      // A journal date is a calendar day, not an instant. Formatting it in
      // UTC prevents the user's zone from shifting it to the adjacent day.
      preferences: { ...preferences, timezone: "UTC" },
    };
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid template date: ${String(value)}`);
  }
  return { date, preferences };
};

const numericDateParts = (
  date: Date,
  preferences: RegionalFormatPreferences,
) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: preferences.timezone,
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: Number(read("day")),
    month: Number(read("month")),
    year: Number(read("year")),
  };
};

const isoWeek = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return {
    year: date.getUTCFullYear(),
    week: Math.ceil(
      ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
    ),
  };
};

/**
 * Variables supported by every document-template application path.
 *
 * The caller supplies the effective account locale, timezone and date-format
 * projection. Date-only values retain calendar semantics; instants are
 * rendered in the effective timezone.
 */
export const buildTemplateVariables = (
  value: TemplateDateInput,
  regionalPreferences: RegionalFormatPreferences,
): Record<string, string> => {
  const { date, preferences } = normalizedTemplateDate(
    value,
    regionalPreferences,
  );
  const { day, month, year } = numericDateParts(date, preferences);
  const isoWeekDate = isoWeek(year, month, day);
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(preferences.locale, {
      ...options,
      timeZone: preferences.timezone,
    }).format(date);

  return {
    ...optionalProjectTemplateVariables(),
    ...optionalPreparationTemplateVariables(),
    date: formatRegionalDate(date, preferences),
    date_long: format({ dateStyle: "long" }),
    weekday: format({ weekday: "long" }),
    week: String(isoWeekDate.week),
    "calendar.iso_week_year": String(isoWeekDate.year),
    month: format({ month: "long", year: "numeric" }),
    quarter: `Q${Math.ceil(month / 3)} ${year}`,
    year: String(year),
    iso: `${String(year).padStart(4, "0")}-${String(month).padStart(
      2,
      "0",
    )}-${String(day).padStart(2, "0")}`,
  };
};

export const replaceTemplateVariables = (
  value: string,
  variables: Readonly<Record<string, string>>,
) => {
  let result = value;
  // Work backwards over the authored input. Inserted braces are literal data,
  // not expressions to discover or evaluate in a second substitution pass.
  for (const range of templateVariableRanges(value).reverse()) {
    if (Object.prototype.hasOwnProperty.call(variables, range.name)) {
      result =
        result.slice(0, range.start) +
        variables[range.name] +
        result.slice(range.start + range.length);
    }
  }
  return result;
};

export const findUnresolvedTemplateVariables = (value: string): string[] => {
  const unresolved = new Set<string>();
  for (const { name } of templateVariableRanges(value)) {
    unresolved.add(name);
  }
  return [...unresolved].sort();
};
