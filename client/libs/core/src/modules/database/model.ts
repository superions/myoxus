// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseCalendarDateMode,
  DatabaseCalendarInitialRange,
  DatabaseCardDensity,
  type DatabaseCellValueInput,
  DatabaseDurationDisplayUnit,
  type DatabaseFieldConfigInput,
  DatabaseFieldKind,
  type DatabaseFieldWidthInput,
  DatabaseFileMimeCategory,
  DatabaseFilesPreviewPolicy,
  type DatabaseFilterGroupInput,
  type DatabaseFilterRuleInput,
  type DatabaseFilterValueInput,
  DatabaseFormulaStalePolicy,
  DatabaseGalleryCardDensity,
  type DatabaseGanttViewConfigInput,
  type DatabaseGroupRuleInput,
  DatabaseListDensity,
  DatabaseProfileKind,
  DatabaseRelativeDatePreset,
  DatabaseRollupStalePolicy,
  type DatabaseSelectOptionInput,
  type DatabaseSortRuleInput,
  DatabaseStatusGroup,
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
  type DatabaseViewConfigInput,
  DatabaseViewKind,
} from "@myoxus/graphql";

import {
  formatRegionalDate,
  formatRegionalDateTime,
  type RegionalFormatPreferences,
} from "../i18n";
import type {
  DatabaseCellValue,
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseView,
} from "./types";

export const WORKSPACE_DATABASE_PAGE_SIZE = 100;

/** Propose a default label from the server snapshot; the server still owns uniqueness. */
export function proposeDatabaseViewName(
  record: Pick<DatabaseRecord, "views">,
  defaultName: string,
): string {
  const names = new Set(record.views.map((view) => view.name.toLowerCase()));
  let candidate = defaultName;
  let suffix = 2;
  while (names.has(candidate.toLowerCase())) {
    candidate = `${defaultName} (${suffix++})`;
  }
  return candidate;
}

/**
 * Return the optimistic-concurrency baseline for one independently mutable
 * cell. Missing cells deliberately use revision zero: the server can then
 * atomically distinguish the first insert from a concurrent insert.
 */
export function getDatabaseCellEditRevision(
  row: DatabaseRowRecord,
  fieldId: string,
): number {
  return (
    row.cellRevisions.find((revision) => revision.fieldId === fieldId)
      ?.editRevision ?? 0
  );
}

export function sortByPosition<T extends { position: number }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => a.position - b.position);
}

type DatabaseViewSummaryLike = Omit<DatabaseView, "config"> & {
  config: { kind: DatabaseViewKind };
};

export function inflateDatabaseViewSummary(
  view: DatabaseViewSummaryLike,
): DatabaseView {
  return {
    ...view,
    config: {
      calendar: null,
      gallery: null,
      gantt: null,
      kanban: null,
      kind: view.config.kind,
      list: null,
      progress: null,
      table: null,
      timeline: null,
    },
  };
}

export function getTitleField(record: DatabaseRecord): DatabaseField {
  const titleField = record.fields.find(
    (field) => field.fieldType === DatabaseFieldKind.Title,
  );
  if (!titleField) {
    throw new Error("Database record is missing its title field.");
  }
  return titleField;
}

export function getPrimaryView(
  record: DatabaseRecord,
  viewId?: string | null,
): DatabaseView {
  const view = getPrimaryViewOrNull(record, viewId);
  if (!view) {
    throw new Error("Database record is missing a view.");
  }
  return view;
}

/**
 * Resolves server-owned semantic view metadata without inferring a role from a
 * mutable view name or its current position. A stale mapping is unavailable so
 * each caller can retain its explicit fallback policy.
 */
export function getViewByRole(
  record: DatabaseRecord,
  roleKey: string,
): DatabaseView | null {
  const viewId = record.viewRoles.find(
    (role) => role.roleKey === roleKey,
  )?.viewId;
  return viewId
    ? (record.views.find((view) => view.id === viewId) ?? null)
    : null;
}

export function getPrimaryViewOrNull(
  record: DatabaseRecord,
  viewId?: string | null,
): DatabaseView | null {
  const requested = viewId
    ? record.views.find((view) => view.id === viewId)
    : undefined;
  const semanticDefault =
    record.database.profileKind === DatabaseProfileKind.Project
      ? getViewByRole(record, "project.kanban")
      : null;
  const first = sortByPosition(record.views)[0];
  return requested ?? semanticDefault ?? first ?? null;
}

export function getFieldById(
  record: DatabaseRecord,
  fieldId: string,
): DatabaseField | undefined {
  return record.fields.find((field) => field.id === fieldId);
}

export function getVisibleFields(
  record: DatabaseRecord,
  view: DatabaseView,
): DatabaseField[] {
  const ids = getVisibleFieldIds(record, view);
  const fields = ids
    .map((id) => getFieldById(record, id))
    .filter((field): field is DatabaseField => Boolean(field));
  const titleField = getTitleField(record);
  if (!fields.some((field) => field.id === titleField.id)) {
    return [titleField, ...fields];
  }
  return fields;
}

export function getVisibleFieldIds(
  record: DatabaseRecord,
  view: DatabaseView,
): string[] {
  const titleField = getTitleField(record);
  const configuredIds = getConfiguredVisibleFieldIds(view);
  const fieldIds = new Set(record.fields.map((field) => field.id));
  const ids = configuredIds.length
    ? configuredIds.filter((id) => fieldIds.has(id))
    : sortByPosition(record.fields).map((field) => field.id);
  return ids.includes(titleField.id) ? ids : [titleField.id, ...ids];
}

export function databaseFieldSupportsSearch(field: DatabaseField): boolean {
  return field.fieldType !== DatabaseFieldKind.Files;
}

/** Mirrors the server's typed saved-sort matrix. Collection-like, relation,
 * file and derived values stay unavailable until their ordering has an
 * explicit product meaning instead of serialized JSON ordering. */
export function databaseFieldSupportsSavedSort(field: DatabaseField): boolean {
  return [
    DatabaseFieldKind.Title,
    DatabaseFieldKind.Text,
    DatabaseFieldKind.RichText,
    DatabaseFieldKind.Number,
    DatabaseFieldKind.Percent,
    DatabaseFieldKind.Currency,
    DatabaseFieldKind.Duration,
    DatabaseFieldKind.Checkbox,
    DatabaseFieldKind.Date,
    DatabaseFieldKind.DateTime,
    DatabaseFieldKind.UniqueId,
    DatabaseFieldKind.Select,
    DatabaseFieldKind.Status,
    DatabaseFieldKind.User,
    DatabaseFieldKind.Users,
    DatabaseFieldKind.Url,
    DatabaseFieldKind.Email,
    DatabaseFieldKind.Phone,
    DatabaseFieldKind.CreatedTime,
    DatabaseFieldKind.UpdatedTime,
  ].includes(field.fieldType);
}

export function getViewSortRules(view: DatabaseView): DatabaseSortRuleInput[] {
  const rules = getConfiguredSortRules(view);
  return rules.map((rule) => ({
    direction: rule.direction,
    fieldId: rule.fieldId,
  }));
}

/**
 * GraphQL exposes filter operands as a stable tagged output object while
 * mutations accept a one-of input. Keep that boundary explicit so persisted
 * typed values never collapse back to route-local JSON conventions.
 */
export function databaseFilterValueInputFromOutput(value: {
  kind: string;
  value: unknown;
}): DatabaseFilterValueInput {
  const candidate = value.value as Record<string, unknown> | null;
  switch (value.kind) {
    case "none":
      return { none: true };
    case "text":
      return { text: String(value.value ?? "") };
    case "number":
      return { number: Number(value.value) };
    case "number_range":
      return {
        numberRange: {
          end: candidate?.end == null ? null : Number(candidate.end),
          start: candidate?.start == null ? null : Number(candidate.start),
        },
      };
    case "currency":
      return {
        currency: {
          amount: Number(candidate?.amount),
          currencyCode: String(candidate?.currencyCode ?? ""),
        },
      };
    case "currency_range":
      return {
        currencyRange: {
          currencyCode: String(candidate?.currencyCode ?? ""),
          end: candidate?.end == null ? null : Number(candidate.end),
          start: candidate?.start == null ? null : Number(candidate.start),
        },
      };
    case "duration":
      return { duration: { minutes: Number(candidate?.minutes) } };
    case "duration_range":
      return {
        durationRange: {
          endMinutes: candidate?.end == null ? null : Number(candidate.end),
          startMinutes:
            candidate?.start == null ? null : Number(candidate.start),
        },
      };
    case "option_id":
      return { optionId: String(value.value ?? "") };
    case "ids":
      return { ids: Array.isArray(value.value) ? value.value.map(String) : [] };
    case "date":
      return { date: String(value.value ?? "") };
    case "date_range":
      return {
        dateRange: {
          end: candidate?.end == null ? null : String(candidate.end),
          start: candidate?.start == null ? null : String(candidate.start),
        },
      };
    case "instant":
      return { instant: String(value.value ?? "") };
    case "instant_range":
      return {
        instantRange: {
          end: candidate?.end == null ? null : String(candidate.end),
          start: candidate?.start == null ? null : String(candidate.start),
        },
      };
    case "relative_date":
      return {
        relativeDate: databaseRelativeDatePresetFromOutput(
          String(candidate?.preset ?? value.value),
        ),
      };
    case "user_id":
      return { userId: String(value.value ?? "") };
    case "user_ids":
      return {
        userIds: Array.isArray(value.value) ? value.value.map(String) : [],
      };
    case "relation_row_id":
      return { relationRowId: String(value.value ?? "") };
    case "relation_row_ids":
      return {
        relationRowIds: Array.isArray(value.value)
          ? value.value.map(String)
          : [],
      };
    case "boolean":
      return { boolean: Boolean(value.value) };
    default:
      throw new Error(`Unsupported database filter value kind: ${value.kind}`);
  }
}

function databaseRelativeDatePresetFromOutput(
  value: string,
): DatabaseRelativeDatePreset {
  const preset = Object.values(DatabaseRelativeDatePreset).find(
    (candidate) => candidate.toLowerCase() === value.replaceAll("_", ""),
  );
  if (!preset) {
    throw new Error(`Unsupported relative date preset: ${value}`);
  }
  return preset;
}

type DatabaseFilterRuleOutput = {
  fieldId: string;
  operator: DatabaseFilterRuleInput["operator"];
  value: { kind: string; value: unknown };
};

type DatabaseFilterGroupOutput = {
  conjunction: NonNullable<DatabaseFilterGroupInput["conjunction"]>;
  rules: DatabaseFilterRuleOutput[];
  groups?: DatabaseFilterGroupOutput[];
};

function databaseFilterRuleInputFromOutput(
  rule: DatabaseFilterRuleOutput,
): DatabaseFilterRuleInput {
  return {
    fieldId: rule.fieldId,
    operator: rule.operator,
    value: databaseFilterValueInputFromOutput(rule.value),
  };
}

export function databaseFilterGroupInputFromOutput(
  group: DatabaseFilterGroupOutput,
): DatabaseFilterGroupInput {
  return {
    conjunction: group.conjunction,
    groups: (group.groups ?? []).map(databaseFilterGroupInputFromOutput),
    rules: group.rules.map(databaseFilterRuleInputFromOutput),
  };
}

export function getViewFilterRules(
  view: DatabaseView,
): DatabaseFilterRuleInput[] {
  return getConfiguredFilterRules(view).map(databaseFilterRuleInputFromOutput);
}

export function getViewFilterTree(
  view: DatabaseView,
): DatabaseFilterGroupInput | null {
  const tree = getConfiguredFilterTree(view);
  return tree ? databaseFilterGroupInputFromOutput(tree) : null;
}

export function getViewGroupRules(view: DatabaseView): {
  group: DatabaseGroupRuleInput | null;
  subgroup: DatabaseGroupRuleInput | null;
} {
  if (view.config.gantt?.group) {
    return {
      group: {
        descending: view.config.gantt.group.descending,
        fieldId: view.config.gantt.group.fieldId,
        showEmptyGroups: view.config.gantt.group.showEmptyGroups,
      },
      subgroup: null,
    };
  }
  const config =
    view.config.table ??
    view.config.list ??
    view.config.gallery ??
    view.config.calendar;
  return {
    group: config?.group
      ? {
          descending: config.group.descending,
          fieldId: config.group.fieldId,
          showEmptyGroups: config.group.showEmptyGroups,
        }
      : null,
    subgroup: config?.subgroup
      ? {
          descending: config.subgroup.descending,
          fieldId: config.subgroup.fieldId,
          showEmptyGroups: config.subgroup.showEmptyGroups,
        }
      : null,
  };
}

function getConfiguredFilterRules(view: DatabaseView) {
  switch (view.viewKind) {
    case DatabaseViewKind.Calendar:
      return view.config.calendar?.filter ?? [];
    case DatabaseViewKind.Gallery:
      return view.config.gallery?.filter ?? [];
    case DatabaseViewKind.Gantt:
      return view.config.gantt?.filter ?? [];
    case DatabaseViewKind.Kanban:
      return view.config.kanban?.filter ?? [];
    case DatabaseViewKind.List:
      return view.config.list?.filter ?? [];
    case DatabaseViewKind.Progress:
      return view.config.progress?.filter ?? [];
    case DatabaseViewKind.Timeline:
      return view.config.timeline?.filter ?? [];
    case DatabaseViewKind.Table:
    default:
      return view.config.table?.filter ?? [];
  }
}

function getConfiguredFilterTree(view: DatabaseView) {
  switch (view.viewKind) {
    case DatabaseViewKind.Calendar:
      return view.config.calendar?.filterTree ?? null;
    case DatabaseViewKind.Gallery:
      return view.config.gallery?.filterTree ?? null;
    case DatabaseViewKind.Gantt:
      return view.config.gantt?.filterTree ?? null;
    case DatabaseViewKind.Kanban:
      return view.config.kanban?.filterTree ?? null;
    case DatabaseViewKind.List:
      return view.config.list?.filterTree ?? null;
    case DatabaseViewKind.Progress:
      return view.config.progress?.filterTree ?? null;
    case DatabaseViewKind.Timeline:
      return view.config.timeline?.filterTree ?? null;
    case DatabaseViewKind.Table:
    default:
      return view.config.table?.filterTree ?? null;
  }
}

function getConfiguredVisibleFieldIds(view: DatabaseView): string[] {
  switch (view.viewKind) {
    case DatabaseViewKind.Calendar:
      return view.config.calendar?.visibleFieldIds ?? [];
    case DatabaseViewKind.Gallery:
      return view.config.gallery?.visibleFieldIds ?? [];
    case DatabaseViewKind.Gantt:
      return view.config.gantt?.visibleFieldIds ?? [];
    case DatabaseViewKind.Kanban:
      return view.config.kanban?.visibleFieldIds ?? [];
    case DatabaseViewKind.List:
      return view.config.list?.visibleFieldIds ?? [];
    case DatabaseViewKind.Progress:
      return view.config.progress?.visibleFieldIds ?? [];
    case DatabaseViewKind.Timeline:
      return view.config.timeline?.visibleFieldIds ?? [];
    case DatabaseViewKind.Table:
    default:
      return view.config.table?.visibleFieldIds ?? [];
  }
}

function getConfiguredSortRules(view: DatabaseView) {
  switch (view.viewKind) {
    case DatabaseViewKind.Calendar:
      return view.config.calendar?.sort ?? [];
    case DatabaseViewKind.Gallery:
      return view.config.gallery?.sort ?? [];
    case DatabaseViewKind.Gantt:
      return view.config.gantt?.sort ?? [];
    case DatabaseViewKind.Kanban:
      return view.config.kanban?.sort ?? [];
    case DatabaseViewKind.List:
      return view.config.list?.sort ?? [];
    case DatabaseViewKind.Progress:
      return view.config.progress?.sort ?? [];
    case DatabaseViewKind.Timeline:
      return view.config.timeline?.sort ?? [];
    case DatabaseViewKind.Table:
    default:
      return view.config.table?.sort ?? [];
  }
}

export function getCellValue(
  row: DatabaseRowRecord,
  fieldId: string,
): DatabaseCellValue | undefined {
  return row.cells.find((cell) => cell.fieldId === fieldId);
}

export function getSelectOptions(field: DatabaseField) {
  if (field.fieldType === DatabaseFieldKind.MultiSelect) {
    return sortByPosition(field.config.multiSelect?.options ?? []);
  }
  if (field.fieldType === DatabaseFieldKind.Select) {
    return sortByPosition(field.config.select?.options ?? []);
  }
  if (field.fieldType === DatabaseFieldKind.Status) {
    return sortByPosition(field.config.status?.options ?? []);
  }
  return [];
}

export function optionLabel(
  field: DatabaseField,
  optionId: string | null | undefined,
) {
  if (!optionId) return "";
  return (
    getSelectOptions(field).find((option) => option.id === optionId)?.name ??
    optionId
  );
}

type DatabaseComputedScalar =
  | NonNullable<DatabaseCellValue["value"]["rollup"]>["value"]
  | NonNullable<DatabaseCellValue["value"]["formula"]>["value"];

function computedScalarPrimitive(value: DatabaseComputedScalar) {
  if (!value) return null;
  switch (value.kind) {
    case DatabaseFieldKind.Checkbox:
      return value.checkbox ?? false;
    case DatabaseFieldKind.Date:
      return value.date?.start ? String(value.date.start) : "";
    case DatabaseFieldKind.Number:
      return value.number ?? "";
    case DatabaseFieldKind.Currency:
      return "currency" in value ? (value.currency ?? "") : "";
    case DatabaseFieldKind.Duration:
      return "duration" in value ? (value.duration ?? "") : "";
    case DatabaseFieldKind.Text:
      return value.text ?? "";
    default:
      return null;
  }
}

export function isDatabaseProjectionField(fieldType: DatabaseFieldKind) {
  return (
    fieldType === DatabaseFieldKind.CreatedTime ||
    fieldType === DatabaseFieldKind.CreatedBy ||
    fieldType === DatabaseFieldKind.UpdatedTime ||
    fieldType === DatabaseFieldKind.UpdatedBy
  );
}

export function isDatabaseDateSourceField(fieldType: DatabaseFieldKind) {
  return (
    fieldType === DatabaseFieldKind.Date ||
    fieldType === DatabaseFieldKind.DateTime ||
    fieldType === DatabaseFieldKind.CreatedTime ||
    fieldType === DatabaseFieldKind.UpdatedTime
  );
}

export function databaseDateSourceValue(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return datePrefix ?? null;
}

export function formatDateOnly(
  value: unknown,
  locale: string,
  regionalPreferences?: RegionalFormatPreferences,
) {
  const dateValue = databaseDateSourceValue(value);
  if (!dateValue) return String(value ?? "");
  const date = new Date(`${dateValue}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  if (regionalPreferences) {
    return formatRegionalDate(date, {
      ...regionalPreferences,
      timezone: "UTC",
    });
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function formatDateTime(
  value: unknown,
  locale: string,
  regionalPreferences?: RegionalFormatPreferences,
) {
  if (typeof value !== "string" || !value) return String(value ?? "");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  if (regionalPreferences) {
    return formatRegionalDateTime(date, regionalPreferences);
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function normalizeDateTimeStart(value: unknown) {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<{ start: unknown }>;
    return typeof candidate.start === "string" ? candidate.start : "";
  }
  return typeof value === "string" ? value : "";
}

function defaultDateTimeZone(field?: DatabaseField | null) {
  return field?.config.dateTime?.defaultTimeZone || "UTC";
}

function normalizeDateTimeInput(value: unknown, field: DatabaseField) {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<{
      allDay: unknown;
      end: unknown;
      start: unknown;
      timeZone: unknown;
    }>;
    return {
      allDay: Boolean(candidate.allDay),
      end:
        typeof candidate.end === "string" && candidate.end
          ? candidate.end
          : null,
      start: normalizeDateTimeStart(candidate),
      timeZone:
        typeof candidate.timeZone === "string" && candidate.timeZone
          ? candidate.timeZone
          : defaultDateTimeZone(field),
    };
  }
  return {
    allDay: false,
    end: null,
    start: normalizeDateTimeStart(value),
    timeZone: defaultDateTimeZone(field),
  };
}

function normalizeDatabaseFileReference(item: unknown) {
  if (typeof item === "object" && item !== null) {
    const file = item as Record<string, unknown>;
    const blobKey = String(file.blobKey ?? "").trim();
    if (!blobKey) {
      return null;
    }
    return {
      blobKey,
      name: typeof file.name === "string" ? file.name : null,
      mime: typeof file.mime === "string" ? file.mime : null,
      size: typeof file.size === "number" ? file.size : null,
      caption: typeof file.caption === "string" ? file.caption : null,
      cover: Boolean(file.cover),
    };
  }
  const blobKey = String(item ?? "").trim();
  return blobKey
    ? {
        blobKey,
        name: null,
        mime: null,
        size: null,
        caption: null,
        cover: false,
      }
    : null;
}

function normalizeDatabaseFilesCellValue(value: unknown) {
  if (typeof value === "object" && value !== null && "files" in value) {
    const candidate = value as Partial<{
      files: unknown;
    }>;
    if (Array.isArray(candidate.files)) {
      return candidate.files
        .map(normalizeDatabaseFileReference)
        .filter((file) => file !== null);
    }
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeDatabaseFileReference)
      .filter((file) => file !== null);
  }
  return String(value ?? "")
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((blobKey) => ({
      blobKey,
      name: null,
      mime: null,
      size: null,
      caption: null,
      cover: false,
    }));
}

function defaultCurrencyForField(field: DatabaseField) {
  return field.config.currency?.defaultCurrency ?? "EUR";
}

function durationDisplayUnitForField(field: DatabaseField) {
  return (
    field.config.duration?.displayUnit ?? DatabaseDurationDisplayUnit.Minutes
  );
}

export function normalizeDatabaseDurationCellValue(
  value: unknown,
): { minutes: number } | null {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<{ minutes: unknown }>;
    const minutes =
      typeof candidate.minutes === "number"
        ? candidate.minutes
        : Number.parseFloat(String(candidate.minutes ?? ""));
    if (Number.isFinite(minutes)) {
      return { minutes: Math.round(minutes) };
    }
  }

  const minutes =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(minutes) ? { minutes: Math.round(minutes) } : null;
}

export function normalizeDatabaseCurrencyCellValue(
  value: unknown,
  field: DatabaseField,
): { amount: number; currencyCode: string } | null {
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<{
      amount: unknown;
      currencyCode: unknown;
      currency_code: unknown;
    }>;
    const amount =
      typeof candidate.amount === "number"
        ? candidate.amount
        : Number.parseFloat(String(candidate.amount ?? ""));
    const rawCurrency = String(
      candidate.currencyCode ?? candidate.currency_code ?? "",
    )
      .trim()
      .toUpperCase();
    if (Number.isFinite(amount)) {
      return {
        amount,
        currencyCode: rawCurrency || defaultCurrencyForField(field),
      };
    }
  }

  const amount =
    typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(amount)) return null;
  return { amount, currencyCode: defaultCurrencyForField(field) };
}

export function formatCurrencyValue(
  value: unknown,
  field: DatabaseField,
  locale: string,
) {
  const currency = normalizeDatabaseCurrencyCellValue(value, field);
  if (!currency) return "";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.currencyCode,
    }).format(currency.amount);
  } catch {
    return `${new Intl.NumberFormat(locale).format(currency.amount)} ${
      currency.currencyCode
    }`;
  }
}

export function formatDurationValue(
  value: unknown,
  field: DatabaseField,
  locale: string,
) {
  const duration = normalizeDatabaseDurationCellValue(value);
  if (!duration) return "";
  const unit = durationDisplayUnitForField(field);
  const numberFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === DatabaseDurationDisplayUnit.Minutes ? 0 : 2,
  });
  if (unit === DatabaseDurationDisplayUnit.Days) {
    return `${numberFormatter.format(duration.minutes / 1440)} d`;
  }
  if (unit === DatabaseDurationDisplayUnit.Hours) {
    return `${numberFormatter.format(duration.minutes / 60)} h`;
  }
  return `${numberFormatter.format(duration.minutes)} min`;
}

export function getCellPrimitiveValue(
  row: DatabaseRowRecord,
  field: DatabaseField,
) {
  if (field.fieldType === DatabaseFieldKind.Title) {
    return row.row.title;
  }
  const value = getCellValue(row, field.id)?.value;
  if (!value) return null;
  switch (field.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return value.checkbox ?? false;
    case DatabaseFieldKind.Date:
      return value.date?.start ?? "";
    case DatabaseFieldKind.DateTime:
      return value.dateTime?.start ?? "";
    case DatabaseFieldKind.Files:
      return value.files?.files ?? [];
    case DatabaseFieldKind.RichText:
      return value.richText ?? null;
    case DatabaseFieldKind.UniqueId:
      return value.uniqueId?.display ?? "";
    case DatabaseFieldKind.MultiSelect:
      return value.multiSelect ?? [];
    case DatabaseFieldKind.Tags:
      return value.tags ?? [];
    case DatabaseFieldKind.Status:
      return value.status ?? "";
    case DatabaseFieldKind.Users:
      return value.users ?? [];
    case DatabaseFieldKind.Number:
      return value.number ?? "";
    case DatabaseFieldKind.Percent:
      return value.percent ?? "";
    case DatabaseFieldKind.Currency:
      return value.currency ?? "";
    case DatabaseFieldKind.Duration:
      return value.duration ?? "";
    case DatabaseFieldKind.Select:
      return value.select ?? "";
    case DatabaseFieldKind.Text:
      return value.text ?? "";
    case DatabaseFieldKind.User:
      return value.user ?? "";
    case DatabaseFieldKind.DocumentLink:
      return value.documentLink ?? null;
    case DatabaseFieldKind.Relation:
      return value.relation ?? [];
    case DatabaseFieldKind.Rollup:
      return computedScalarPrimitive(value.rollup?.value ?? null);
    case DatabaseFieldKind.Formula:
      return computedScalarPrimitive(value.formula?.value ?? null);
    case DatabaseFieldKind.Url:
      return value.url ?? "";
    case DatabaseFieldKind.Email:
      return value.email ?? "";
    case DatabaseFieldKind.Phone:
      return value.phone ?? "";
    case DatabaseFieldKind.CreatedTime:
      return value.createdTime ?? "";
    case DatabaseFieldKind.CreatedBy:
      return value.createdBy ?? "";
    case DatabaseFieldKind.UpdatedTime:
      return value.updatedTime ?? "";
    case DatabaseFieldKind.UpdatedBy:
      return value.updatedBy ?? "";
    default:
      return null;
  }
}

export function formatCellValue(
  row: DatabaseRowRecord,
  field: DatabaseField,
  locale: string,
  labels?: { checkboxTrue?: string },
  regionalPreferences?: RegionalFormatPreferences,
) {
  const value = getCellPrimitiveValue(row, field);
  if (value === null || value === "") return "";
  if (field.fieldType === DatabaseFieldKind.Checkbox) {
    return value ? (labels?.checkboxTrue ?? "true") : "";
  }
  if (
    field.fieldType === DatabaseFieldKind.Select ||
    field.fieldType === DatabaseFieldKind.Status
  ) {
    return optionLabel(field, String(value));
  }
  if (field.fieldType === DatabaseFieldKind.MultiSelect) {
    return Array.isArray(value)
      ? value.map((id) => optionLabel(field, id)).join(", ")
      : "";
  }
  if (field.fieldType === DatabaseFieldKind.Tags) {
    return Array.isArray(value) ? value.join(", ") : "";
  }
  if (field.fieldType === DatabaseFieldKind.Users) {
    return Array.isArray(value) ? value.join(", ") : "";
  }
  if (field.fieldType === DatabaseFieldKind.DocumentLink) {
    const documentLink =
      typeof value === "object" && value !== null
        ? (value as {
            target?: { state?: string; title?: string | null } | null;
          })
        : null;
    return documentLink?.target?.state === "Available"
      ? (documentLink.target.title ?? "")
      : "";
  }
  if (field.fieldType === DatabaseFieldKind.Relation) {
    const cell = getCellValue(row, field.id);
    const targets = cell?.value.relationTargets ?? [];
    if (targets.length) {
      return targets
        .map((target) =>
          target.redacted ? target.rowId : (target.title ?? target.rowId),
        )
        .join(", ");
    }
    return Array.isArray(value) ? value.join(", ") : "";
  }
  if (field.fieldType === DatabaseFieldKind.Date) {
    return formatDateOnly(value, locale, regionalPreferences);
  }
  if (field.fieldType === DatabaseFieldKind.DateTime) {
    const dateTime = getCellValue(row, field.id)?.value.dateTime;
    if (dateTime?.allDay) {
      const date = new Date(dateTime.start);
      if (Number.isNaN(date.getTime())) return String(value);
      return regionalPreferences
        ? formatRegionalDate(date, {
            ...regionalPreferences,
            timezone: dateTime.timeZone,
          })
        : new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeZone: dateTime.timeZone,
          }).format(date);
    }
    return formatDateTime(value, locale, regionalPreferences);
  }
  if (field.fieldType === DatabaseFieldKind.Files) {
    return Array.isArray(value)
      ? value
          .map((file) => file.name || file.blobKey)
          .filter(Boolean)
          .join(", ")
      : "";
  }
  if (field.fieldType === DatabaseFieldKind.RichText) {
    return typeof value === "object" && value && "plainText" in value
      ? String(value.plainText ?? "")
      : "";
  }
  if (field.fieldType === DatabaseFieldKind.UniqueId) {
    return typeof value === "string" ? value : "";
  }
  if (field.fieldType === DatabaseFieldKind.Percent) {
    return `${new Intl.NumberFormat(locale).format(Number(value))}%`;
  }
  if (field.fieldType === DatabaseFieldKind.Currency) {
    return formatCurrencyValue(value, field, locale);
  }
  if (field.fieldType === DatabaseFieldKind.Duration) {
    return formatDurationValue(value, field, locale);
  }
  if (
    field.fieldType === DatabaseFieldKind.CreatedTime ||
    field.fieldType === DatabaseFieldKind.UpdatedTime
  ) {
    return formatDateTime(value, locale, regionalPreferences);
  }
  if (field.fieldType === DatabaseFieldKind.Rollup) {
    const rollupValue = getCellValue(row, field.id)?.value.rollup?.value;
    if (rollupValue?.kind === DatabaseFieldKind.Currency) {
      return formatCurrencyValue(rollupValue.currency, field, locale);
    }
    if (rollupValue?.kind === DatabaseFieldKind.Duration) {
      return formatDurationValue(rollupValue.duration, field, locale);
    }
    if (rollupValue?.kind === DatabaseFieldKind.Date) {
      const dateValue = rollupValue.date?.start;
      if (!dateValue) return "";
      return formatDateOnly(dateValue, locale, regionalPreferences);
    }
  }
  if (field.fieldType === DatabaseFieldKind.Formula) {
    const formulaValue = getCellValue(row, field.id)?.value.formula?.value;
    if (formulaValue?.kind === DatabaseFieldKind.Date) {
      const dateValue = formulaValue.date?.start;
      if (!dateValue) return "";
      return formatDateOnly(dateValue, locale, regionalPreferences);
    }
  }
  return String(value);
}

export function createCellValueInput(
  field: DatabaseField,
  value: unknown,
): DatabaseCellValueInput {
  switch (field.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return { checkbox: Boolean(value) };
    case DatabaseFieldKind.Date:
      return { date: { start: String(value || "") } };
    case DatabaseFieldKind.DateTime:
      return {
        dateTime: normalizeDateTimeInput(value, field),
      };
    case DatabaseFieldKind.Files:
      return { files: { files: normalizeDatabaseFilesCellValue(value) } };
    case DatabaseFieldKind.RichText:
      return {
        richText: {
          document:
            typeof value === "object" && value && "document" in value
              ? value.document
              : value,
        },
      };
    case DatabaseFieldKind.UniqueId:
      throw new Error("UniqueId fields are server-generated and read-only");
    case DatabaseFieldKind.MultiSelect:
      return { multiSelect: Array.isArray(value) ? value.map(String) : [] };
    case DatabaseFieldKind.Tags:
      return { tags: Array.isArray(value) ? value.map(String) : [] };
    case DatabaseFieldKind.Status:
      return { status: String(value || defaultStatusOptionId(field)) };
    case DatabaseFieldKind.Users:
      return { users: Array.isArray(value) ? value.map(String) : [] };
    case DatabaseFieldKind.Number: {
      const number =
        typeof value === "number" ? value : Number.parseFloat(String(value));
      return { number: Number.isFinite(number) ? number : 0 };
    }
    case DatabaseFieldKind.Percent: {
      const percent =
        typeof value === "number" ? value : Number.parseFloat(String(value));
      return { percent: Number.isFinite(percent) ? percent : 0 };
    }
    case DatabaseFieldKind.Currency: {
      const currency = normalizeDatabaseCurrencyCellValue(value, field);
      return {
        currency: currency ?? {
          amount: 0,
          currencyCode: defaultCurrencyForField(field),
        },
      };
    }
    case DatabaseFieldKind.Duration: {
      return {
        duration: normalizeDatabaseDurationCellValue(value) ?? { minutes: 0 },
      };
    }
    case DatabaseFieldKind.Select:
      return { select: String(value || "") };
    case DatabaseFieldKind.Text:
      return { text: String(value ?? "") };
    case DatabaseFieldKind.User:
      return { user: String(value || "") };
    case DatabaseFieldKind.DocumentLink: {
      const documentLink =
        typeof value === "object" && value !== null && "docId" in value
          ? value
          : { docId: value };
      return {
        documentLink: {
          docId: String(documentLink.docId || ""),
          ...("workspaceId" in documentLink &&
          typeof documentLink.workspaceId === "string"
            ? { workspaceId: documentLink.workspaceId }
            : {}),
        },
      };
    }
    case DatabaseFieldKind.Relation:
      return { relation: Array.isArray(value) ? value.map(String) : [] };
    case DatabaseFieldKind.Url:
      return { url: String(value ?? "") };
    case DatabaseFieldKind.Email:
      return { email: String(value ?? "") };
    case DatabaseFieldKind.Phone:
      return { phone: String(value ?? "") };
    case DatabaseFieldKind.Title:
      throw new Error("Title updates use updateDatabaseRowTitle.");
    case DatabaseFieldKind.Rollup:
      throw new Error("Rollup fields are read-only computed values.");
    case DatabaseFieldKind.Formula:
      throw new Error("Formula fields are read-only computed values.");
    case DatabaseFieldKind.CreatedTime:
    case DatabaseFieldKind.CreatedBy:
    case DatabaseFieldKind.UpdatedTime:
    case DatabaseFieldKind.UpdatedBy:
      throw new Error("Projection fields are read-only computed values.");
    default:
      throw new Error(`Unsupported database field type: ${field.fieldType}`);
  }
}

export function defaultStatusFieldConfigInput(): DatabaseFieldConfigInput {
  return {
    status: {
      defaultOptionId: "status.todo",
      options: [
        {
          colorRole: "database.status.todo",
          group: DatabaseStatusGroup.NotStarted,
          id: "status.todo",
          name: "Todo",
          position: 0,
        },
        {
          colorRole: "database.status.inProgress",
          group: DatabaseStatusGroup.Active,
          id: "status.in_progress",
          name: "In progress",
          position: 1,
        },
        {
          colorRole: "database.status.done",
          group: DatabaseStatusGroup.Complete,
          id: "status.done",
          name: "Done",
          position: 2,
        },
      ],
    },
  };
}

export function defaultStatusOptionId(field?: DatabaseField | null) {
  return field?.config.status?.defaultOptionId || "status.todo";
}

export function defaultFieldConfigInput(
  fieldType: DatabaseFieldKind,
  options: {
    formulaConfig?: NonNullable<DatabaseFieldConfigInput["formula"]>;
    relationTargetDatabaseId?: string;
    rollupConfig?: NonNullable<DatabaseFieldConfigInput["rollup"]>;
  } = {},
): DatabaseFieldConfigInput | null {
  switch (fieldType) {
    case DatabaseFieldKind.Date:
      return { date: { includeTime: false } };
    case DatabaseFieldKind.DateTime:
      return { dateTime: { defaultTimeZone: "UTC", allowReminders: false } };
    case DatabaseFieldKind.Files:
      return {
        files: {
          allowedMimeCategories: [DatabaseFileMimeCategory.Any],
          maxItemCount: null,
          maxItemSize: null,
          previewPolicy: DatabaseFilesPreviewPolicy.Auto,
        },
      };
    case DatabaseFieldKind.RichText:
      return { richText: { maxPlainTextBytes: null } };
    case DatabaseFieldKind.UniqueId:
      return { uniqueId: { prefix: "", startNumber: 1, padding: 3 } };
    case DatabaseFieldKind.MultiSelect:
      return { multiSelect: { options: [] } };
    case DatabaseFieldKind.Tags:
      return { tags: { maxCount: null } };
    case DatabaseFieldKind.Number:
      return { number: { format: null } };
    case DatabaseFieldKind.Percent:
      return { percent: { minValue: null, maxValue: null } };
    case DatabaseFieldKind.Currency:
      return {
        currency: {
          defaultCurrency: "EUR",
          allowCurrencyOverride: false,
          minValue: null,
          maxValue: null,
        },
      };
    case DatabaseFieldKind.Duration:
      return {
        duration: {
          displayUnit: DatabaseDurationDisplayUnit.Minutes,
          minMinutes: 0,
          maxMinutes: null,
        },
      };
    case DatabaseFieldKind.Users:
      return { users: { minCount: null, maxCount: null } };
    case DatabaseFieldKind.Select:
      return { select: { options: [] } };
    case DatabaseFieldKind.Status:
      return defaultStatusFieldConfigInput();
    case DatabaseFieldKind.Text:
      return { text: { multiline: false } };
    case DatabaseFieldKind.Relation:
      return {
        relation: {
          allowMultiple: true,
          targetDatabaseId: options.relationTargetDatabaseId ?? "",
        },
      };
    case DatabaseFieldKind.Rollup:
      return options.rollupConfig
        ? {
            rollup: {
              ...options.rollupConfig,
              stalePolicy:
                options.rollupConfig.stalePolicy ??
                DatabaseRollupStalePolicy.Async,
            },
          }
        : null;
    case DatabaseFieldKind.Formula:
      return options.formulaConfig
        ? {
            formula: {
              ...options.formulaConfig,
              stalePolicy:
                options.formulaConfig.stalePolicy ??
                DatabaseFormulaStalePolicy.Async,
            },
          }
        : null;
    case DatabaseFieldKind.Url:
    case DatabaseFieldKind.Email:
    case DatabaseFieldKind.Phone:
    case DatabaseFieldKind.CreatedTime:
    case DatabaseFieldKind.CreatedBy:
    case DatabaseFieldKind.UpdatedTime:
    case DatabaseFieldKind.UpdatedBy:
      return null;
    default:
      return null;
  }
}

export function createTableViewConfigInput(
  record: DatabaseRecord,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    table: {
      searchFieldIds: sortByPosition(record.fields)
        .filter(databaseFieldSupportsSearch)
        .map((field) => field.id),
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
    },
  };
}

export function createKanbanViewConfigInput(
  record: DatabaseRecord,
  groupFieldId: string,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    kanban: {
      cardDensity: DatabaseCardDensity.Default,
      coverFieldId: null,
      groupFieldId,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
    },
  };
}

export function createListViewConfigInput(
  record: DatabaseRecord,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    list: {
      density: DatabaseListDensity.Default,
      showFieldLabels: true,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
    },
  };
}

export function createGalleryViewConfigInput(
  record: DatabaseRecord,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    gallery: {
      cardDensity: DatabaseGalleryCardDensity.Default,
      coverFieldId: null,
      showEmptyCover: true,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
    },
  };
}

export function createCalendarViewConfigInput(
  record: DatabaseRecord,
  dateFieldId: string,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    calendar: {
      dateFieldId,
      dateMode: DatabaseCalendarDateMode.Month,
      initialRange: DatabaseCalendarInitialRange.CurrentMonth,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
    },
  };
}

export function createTimelineViewConfigInput(
  record: DatabaseRecord,
  startFieldId: string,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    timeline: {
      endFieldId: null,
      groupBy: DatabaseTimelineGroupBy.Month,
      order: DatabaseTimelineOrder.Asc,
      startFieldId,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
      zoom: DatabaseTimelineZoom.Month,
    },
  };
}

export function createGanttViewConfigInput(
  record: DatabaseRecord,
  startFieldId: string,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    gantt: {
      dependencyFieldId: null,
      endFieldId: null,
      group: null,
      startFieldId,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
      zoom: DatabaseTimelineZoom.Month,
    },
  };
}

export function createProgressViewConfigInput(
  record: DatabaseRecord,
  progressFieldId: string,
  groupFieldId?: string | null,
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  return {
    progress: {
      groupFieldId,
      progressFieldId,
      titleFieldId: titleField.id,
      visibleFieldIds: sortByPosition(record.fields).map((field) => field.id),
    },
  };
}

function firstViewKindDependency(
  record: DatabaseRecord,
  kind: DatabaseViewKind,
): DatabaseField | null {
  const orderedFields = sortByPosition(record.fields);
  switch (kind) {
    case DatabaseViewKind.Calendar:
    case DatabaseViewKind.Gantt:
    case DatabaseViewKind.Timeline:
      return (
        orderedFields.find((field) =>
          isDatabaseDateSourceField(field.fieldType),
        ) ?? null
      );
    case DatabaseViewKind.Kanban:
      return (
        orderedFields.find(
          (field) =>
            field.fieldType === DatabaseFieldKind.Status ||
            field.fieldType === DatabaseFieldKind.Select,
        ) ?? null
      );
    case DatabaseViewKind.Progress:
      return (
        orderedFields.find(
          (field) => field.fieldType === DatabaseFieldKind.Percent,
        ) ?? null
      );
    default:
      return null;
  }
}

/**
 * Whether a View kind can be materialized from the authoritative schema.
 * Calendar/Gantt/Timeline, Kanban and Progress require a compatible Field; the
 * remaining layouts can always be created from the Database title Field.
 */
export function databaseViewKindIsAvailable(
  record: DatabaseRecord,
  kind: DatabaseViewKind,
): boolean {
  switch (kind) {
    case DatabaseViewKind.Calendar:
    case DatabaseViewKind.Gantt:
    case DatabaseViewKind.Timeline:
    case DatabaseViewKind.Kanban:
    case DatabaseViewKind.Progress:
      return Boolean(firstViewKindDependency(record, kind));
    default:
      return true;
  }
}

/**
 * Convert one View to another server-supported kind without inventing a second
 * View-config model in React. Shared query rules and visible Fields survive the
 * conversion; kind-specific defaults come from the same builders used by View
 * creation. The caller must check `databaseViewKindIsAvailable` first.
 */
export function createViewConfigInputForKind(
  record: DatabaseRecord,
  sourceView: DatabaseView,
  kind: DatabaseViewKind,
  edits?: { visibleFieldIds?: string[] },
): DatabaseViewConfigInput {
  if (kind === sourceView.viewKind) {
    return viewConfigInputFromView(sourceView);
  }

  const dependency = firstViewKindDependency(record, kind);
  if (!databaseViewKindIsAvailable(record, kind)) {
    throw new Error(`Database View kind ${kind} has no compatible Field.`);
  }

  const filter = getViewFilterRules(sourceView);
  const filterTree = getViewFilterTree(sourceView);
  const sort = getViewSortRules(sourceView);
  const visibleFieldIds = normalizeVisibleFieldIds(
    record,
    edits?.visibleFieldIds ?? getVisibleFieldIds(record, sourceView),
  );
  const groups = getViewGroupRules(sourceView);
  const commonState = {
    filter,
    filterTree,
    sort,
    visibleFieldIds,
  };

  switch (kind) {
    case DatabaseViewKind.Kanban: {
      const config = createKanbanViewConfigInput(
        record,
        dependency!.id,
      ).kanban!;
      return { kanban: { ...config, ...commonState } };
    }
    case DatabaseViewKind.List: {
      const config = createListViewConfigInput(record).list!;
      return {
        list: {
          ...config,
          ...commonState,
          group: groups.group,
          subgroup: groups.subgroup,
        },
      };
    }
    case DatabaseViewKind.Gallery: {
      const config = createGalleryViewConfigInput(record).gallery!;
      return {
        gallery: {
          ...config,
          ...commonState,
          group: groups.group,
          subgroup: groups.subgroup,
        },
      };
    }
    case DatabaseViewKind.Calendar: {
      const config = createCalendarViewConfigInput(
        record,
        dependency!.id,
      ).calendar!;
      return {
        calendar: {
          ...config,
          ...commonState,
          group: groups.group,
          subgroup: groups.subgroup,
        },
      };
    }
    case DatabaseViewKind.Gantt: {
      const config = createGanttViewConfigInput(record, dependency!.id).gantt!;
      return { gantt: { ...config, ...commonState } };
    }
    case DatabaseViewKind.Timeline: {
      const config = createTimelineViewConfigInput(
        record,
        dependency!.id,
      ).timeline!;
      return { timeline: { ...config, ...commonState } };
    }
    case DatabaseViewKind.Progress: {
      const config = createProgressViewConfigInput(
        record,
        dependency!.id,
      ).progress!;
      return { progress: { ...config, ...commonState } };
    }
    case DatabaseViewKind.Table:
    default: {
      const config = createTableViewConfigInput(record).table!;
      return {
        table: {
          ...config,
          ...commonState,
          group: groups.group,
          subgroup: groups.subgroup,
        },
      };
    }
  }
}

export function createViewConfigInputFromEdits(
  record: DatabaseRecord,
  view: DatabaseView,
  edits: {
    calendarDateFieldId?: string;
    calendarDateMode?: DatabaseCalendarDateMode;
    calendarInitialRange?: DatabaseCalendarInitialRange;
    cardDensity?: DatabaseCardDensity;
    coverFieldId?: string | null;
    fieldWidths?: DatabaseFieldWidthInput[];
    filter?: DatabaseFilterRuleInput[];
    filterTree?: DatabaseFilterGroupInput | null;
    galleryCardDensity?: DatabaseGalleryCardDensity;
    galleryShowEmptyCover?: boolean;
    ganttDependencyFieldId?: string | null;
    ganttEndFieldId?: string | null;
    ganttGroup?: DatabaseGroupRuleInput | null;
    ganttStartFieldId?: string;
    ganttZoom?: DatabaseTimelineZoom;
    group?: DatabaseGroupRuleInput | null;
    groupFieldId?: string;
    listDensity?: DatabaseListDensity;
    listShowFieldLabels?: boolean;
    progressFieldId?: string;
    searchFieldIds?: string[];
    sort?: DatabaseSortRuleInput[];
    subgroup?: DatabaseGroupRuleInput | null;
    timelineEndFieldId?: string | null;
    timelineGroupBy?: DatabaseTimelineGroupBy;
    timelineOrder?: DatabaseTimelineOrder;
    timelineStartFieldId?: string;
    timelineZoom?: DatabaseTimelineZoom;
    visibleFieldIds?: string[];
  },
): DatabaseViewConfigInput {
  const titleField = getTitleField(record);
  const visibleFieldIds = normalizeVisibleFieldIds(
    record,
    edits.visibleFieldIds ?? getVisibleFieldIds(record, view),
  );
  const sort = edits.sort ?? getViewSortRules(view);
  const filter = edits.filter ?? getViewFilterRules(view);
  const filterTree =
    edits.filterTree === undefined ? getViewFilterTree(view) : edits.filterTree;
  const groups = getViewGroupRules(view);
  const group = edits.group === undefined ? groups.group : edits.group;
  const subgroup =
    edits.subgroup === undefined ? groups.subgroup : edits.subgroup;

  if (view.viewKind === DatabaseViewKind.Kanban) {
    const groupFieldId =
      edits.groupFieldId ?? view.config.kanban?.groupFieldId ?? "";
    return {
      kanban: {
        cardDensity:
          edits.cardDensity ??
          view.config.kanban?.cardDensity ??
          DatabaseCardDensity.Default,
        coverFieldId:
          edits.coverFieldId === undefined
            ? (view.config.kanban?.coverFieldId ?? null)
            : edits.coverFieldId,
        filter,
        filterTree,
        groupFieldId,
        sort,
        titleFieldId: titleField.id,
        visibleFieldIds,
      },
    };
  }

  if (view.viewKind === DatabaseViewKind.List) {
    return {
      list: {
        density:
          edits.listDensity ??
          view.config.list?.density ??
          DatabaseListDensity.Default,
        filter,
        filterTree,
        group,
        showFieldLabels:
          edits.listShowFieldLabels ??
          view.config.list?.showFieldLabels ??
          true,
        sort,
        subgroup,
        titleFieldId: titleField.id,
        visibleFieldIds,
      },
    };
  }

  if (view.viewKind === DatabaseViewKind.Gallery) {
    return {
      gallery: {
        cardDensity:
          edits.galleryCardDensity ??
          view.config.gallery?.cardDensity ??
          DatabaseGalleryCardDensity.Default,
        coverFieldId:
          edits.coverFieldId === undefined
            ? (view.config.gallery?.coverFieldId ?? null)
            : edits.coverFieldId,
        filter,
        filterTree,
        group,
        showEmptyCover:
          edits.galleryShowEmptyCover ??
          view.config.gallery?.showEmptyCover ??
          true,
        sort,
        subgroup,
        titleFieldId: titleField.id,
        visibleFieldIds,
      },
    };
  }

  if (view.viewKind === DatabaseViewKind.Calendar) {
    return {
      calendar: {
        dateFieldId:
          edits.calendarDateFieldId ?? view.config.calendar?.dateFieldId ?? "",
        dateMode:
          edits.calendarDateMode ??
          view.config.calendar?.dateMode ??
          DatabaseCalendarDateMode.Month,
        filter,
        filterTree,
        group,
        initialRange:
          edits.calendarInitialRange ??
          view.config.calendar?.initialRange ??
          DatabaseCalendarInitialRange.CurrentMonth,
        sort,
        subgroup,
        titleFieldId: titleField.id,
        visibleFieldIds,
      },
    };
  }

  if (view.viewKind === DatabaseViewKind.Gantt) {
    const gantt = view.config.gantt;
    if (!gantt) {
      throw new Error("Database Gantt view config is incomplete.");
    }
    const config: DatabaseGanttViewConfigInput = {
      dependencyFieldId:
        edits.ganttDependencyFieldId === undefined
          ? gantt.dependencyFieldId
          : edits.ganttDependencyFieldId,
      endFieldId:
        edits.ganttEndFieldId === undefined
          ? gantt.endFieldId
          : edits.ganttEndFieldId,
      filter,
      filterTree,
      group: edits.ganttGroup === undefined ? gantt.group : edits.ganttGroup,
      sort,
      startFieldId: edits.ganttStartFieldId ?? gantt.startFieldId,
      titleFieldId: titleField.id,
      visibleFieldIds,
      zoom: edits.ganttZoom ?? gantt.zoom,
    };
    return { gantt: config };
  }

  if (view.viewKind === DatabaseViewKind.Timeline) {
    return {
      timeline: {
        endFieldId:
          edits.timelineEndFieldId === undefined
            ? (view.config.timeline?.endFieldId ?? null)
            : edits.timelineEndFieldId,
        filter,
        filterTree,
        groupBy:
          edits.timelineGroupBy ??
          view.config.timeline?.groupBy ??
          DatabaseTimelineGroupBy.Month,
        order:
          edits.timelineOrder ??
          view.config.timeline?.order ??
          DatabaseTimelineOrder.Asc,
        startFieldId:
          edits.timelineStartFieldId ??
          view.config.timeline?.startFieldId ??
          "",
        sort,
        titleFieldId: titleField.id,
        visibleFieldIds,
        zoom:
          edits.timelineZoom ??
          view.config.timeline?.zoom ??
          DatabaseTimelineZoom.Month,
      },
    };
  }

  if (view.viewKind === DatabaseViewKind.Progress) {
    const progress = view.config.progress;
    if (!progress) {
      throw new Error("Database Progress view config is incomplete.");
    }
    return {
      progress: {
        filter,
        filterTree,
        groupFieldId: edits.groupFieldId ?? progress.groupFieldId,
        progressFieldId: edits.progressFieldId ?? progress.progressFieldId,
        sort,
        titleFieldId: progress.titleFieldId,
        visibleFieldIds,
      },
    };
  }

  return {
    table: {
      fieldWidths: edits.fieldWidths ?? view.config.table?.fieldWidths ?? [],
      filter,
      filterTree,
      group,
      searchFieldIds:
        edits.searchFieldIds ?? view.config.table?.searchFieldIds ?? [],
      sort,
      subgroup,
      titleFieldId: titleField.id,
      visibleFieldIds,
    },
  };
}

export function viewConfigInputFromView(
  view: DatabaseView,
): DatabaseViewConfigInput {
  if (view.viewKind === DatabaseViewKind.Kanban && view.config.kanban) {
    return {
      kanban: {
        cardDensity: view.config.kanban.cardDensity,
        coverFieldId: view.config.kanban.coverFieldId,
        filter: view.config.kanban.filter.map(
          databaseFilterRuleInputFromOutput,
        ),
        filterTree: view.config.kanban.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.kanban.filterTree)
          : null,
        groupFieldId: view.config.kanban.groupFieldId,
        sort: view.config.kanban.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        titleFieldId: view.config.kanban.titleFieldId,
        visibleFieldIds: view.config.kanban.visibleFieldIds,
      },
    };
  }
  if (view.config.list) {
    return {
      list: {
        density: view.config.list.density,
        filter: view.config.list.filter.map(databaseFilterRuleInputFromOutput),
        filterTree: view.config.list.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.list.filterTree)
          : null,
        group: view.config.list.group,
        showFieldLabels: view.config.list.showFieldLabels,
        sort: view.config.list.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        subgroup: view.config.list.subgroup,
        titleFieldId: view.config.list.titleFieldId,
        visibleFieldIds: view.config.list.visibleFieldIds,
      },
    };
  }
  if (view.config.gallery) {
    return {
      gallery: {
        cardDensity: view.config.gallery.cardDensity,
        coverFieldId: view.config.gallery.coverFieldId,
        filter: view.config.gallery.filter.map(
          databaseFilterRuleInputFromOutput,
        ),
        filterTree: view.config.gallery.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.gallery.filterTree)
          : null,
        group: view.config.gallery.group,
        showEmptyCover: view.config.gallery.showEmptyCover,
        sort: view.config.gallery.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        subgroup: view.config.gallery.subgroup,
        titleFieldId: view.config.gallery.titleFieldId,
        visibleFieldIds: view.config.gallery.visibleFieldIds,
      },
    };
  }
  if (view.config.calendar) {
    return {
      calendar: {
        dateFieldId: view.config.calendar.dateFieldId,
        dateMode: view.config.calendar.dateMode,
        filter: view.config.calendar.filter.map(
          databaseFilterRuleInputFromOutput,
        ),
        filterTree: view.config.calendar.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.calendar.filterTree)
          : null,
        group: view.config.calendar.group,
        initialRange: view.config.calendar.initialRange,
        sort: view.config.calendar.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        subgroup: view.config.calendar.subgroup,
        titleFieldId: view.config.calendar.titleFieldId,
        visibleFieldIds: view.config.calendar.visibleFieldIds,
      },
    };
  }
  if (view.config.gantt) {
    return {
      gantt: {
        dependencyFieldId: view.config.gantt.dependencyFieldId,
        endFieldId: view.config.gantt.endFieldId,
        filter: view.config.gantt.filter.map(databaseFilterRuleInputFromOutput),
        filterTree: view.config.gantt.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.gantt.filterTree)
          : null,
        group: view.config.gantt.group,
        sort: view.config.gantt.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        startFieldId: view.config.gantt.startFieldId,
        titleFieldId: view.config.gantt.titleFieldId,
        visibleFieldIds: view.config.gantt.visibleFieldIds,
        zoom: view.config.gantt.zoom,
      },
    };
  }
  if (view.config.timeline) {
    return {
      timeline: {
        endFieldId: view.config.timeline.endFieldId,
        filter: view.config.timeline.filter.map(
          databaseFilterRuleInputFromOutput,
        ),
        filterTree: view.config.timeline.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.timeline.filterTree)
          : null,
        groupBy: view.config.timeline.groupBy,
        order: view.config.timeline.order,
        sort: view.config.timeline.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        startFieldId: view.config.timeline.startFieldId,
        titleFieldId: view.config.timeline.titleFieldId,
        visibleFieldIds: view.config.timeline.visibleFieldIds,
        zoom: view.config.timeline.zoom,
      },
    };
  }
  if (view.config.progress) {
    return {
      progress: {
        filter: view.config.progress.filter.map(
          databaseFilterRuleInputFromOutput,
        ),
        filterTree: view.config.progress.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.progress.filterTree)
          : null,
        groupFieldId: view.config.progress.groupFieldId,
        progressFieldId: view.config.progress.progressFieldId,
        sort: view.config.progress.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        titleFieldId: view.config.progress.titleFieldId,
        visibleFieldIds: view.config.progress.visibleFieldIds,
      },
    };
  }
  if (view.config.table) {
    return {
      table: {
        fieldWidths: view.config.table.fieldWidths,
        filter: view.config.table.filter.map(databaseFilterRuleInputFromOutput),
        filterTree: view.config.table.filterTree
          ? databaseFilterGroupInputFromOutput(view.config.table.filterTree)
          : null,
        group: view.config.table.group,
        searchFieldIds: view.config.table.searchFieldIds,
        sort: view.config.table.sort.map((rule) => ({
          direction: rule.direction,
          fieldId: rule.fieldId,
        })),
        subgroup: view.config.table.subgroup,
        titleFieldId: view.config.table.titleFieldId,
        visibleFieldIds: view.config.table.visibleFieldIds,
      },
    };
  }
  throw new Error("Database view config is incomplete.");
}

function normalizeVisibleFieldIds(record: DatabaseRecord, fieldIds: string[]) {
  const titleField = getTitleField(record);
  const validFieldIds = new Set(record.fields.map((field) => field.id));
  const normalized = fieldIds.filter((fieldId) => validFieldIds.has(fieldId));
  return normalized.includes(titleField.id)
    ? normalized
    : [titleField.id, ...normalized];
}

export function sortDatabaseRowsByPosition(rows: DatabaseRowRecord[]) {
  return [...rows].sort(
    (left, right) =>
      left.row.position - right.row.position ||
      left.row.id.localeCompare(right.row.id),
  );
}

export function databaseRowDropPosition(
  rows: DatabaseRowRecord[],
  sourceRowId: string,
  targetRowId: string | null | undefined,
  edge: "top" | "bottom" = "bottom",
) {
  const orderedRows = sortDatabaseRowsByPosition(rows).filter(
    (row) => row.row.id !== sourceRowId,
  );
  if (!targetRowId) return orderedRows.length;
  const targetIndex = orderedRows.findIndex(
    (row) => row.row.id === targetRowId,
  );
  if (targetIndex < 0) return orderedRows.length;
  return edge === "top" ? targetIndex : targetIndex + 1;
}

export function fieldConfigInputFromField(
  field: DatabaseField,
  edits: Partial<{
    allowReminders: boolean;
    includeTime: boolean;
    multiline: boolean;
    numberFormat: string;
    options: DatabaseSelectOptionInput[];
    formulaExpression: string;
    formulaResultType: NonNullable<
      DatabaseFieldConfigInput["formula"]
    >["resultType"];
    filesAllowedMimeCategories: DatabaseFileMimeCategory[];
    filesMaxItemCount: number | null;
    filesMaxItemSize: number | null;
    filesPreviewPolicy: DatabaseFilesPreviewPolicy;
  }> = {},
): DatabaseFieldConfigInput | null {
  switch (field.fieldType) {
    case DatabaseFieldKind.Date:
      return {
        date: {
          includeTime:
            edits.includeTime ?? field.config.date?.includeTime ?? false,
        },
      };
    case DatabaseFieldKind.DateTime:
      return {
        dateTime: {
          allowReminders:
            edits.allowReminders ??
            field.config.dateTime?.allowReminders ??
            false,
          defaultTimeZone: defaultDateTimeZone(field),
        },
      };
    case DatabaseFieldKind.Files:
      return {
        files: {
          allowedMimeCategories: edits.filesAllowedMimeCategories ??
            field.config.files?.allowedMimeCategories ?? [
              DatabaseFileMimeCategory.Any,
            ],
          maxItemCount:
            edits.filesMaxItemCount !== undefined
              ? edits.filesMaxItemCount
              : (field.config.files?.maxItemCount ?? null),
          maxItemSize:
            edits.filesMaxItemSize !== undefined
              ? edits.filesMaxItemSize
              : (field.config.files?.maxItemSize ?? null),
          previewPolicy:
            edits.filesPreviewPolicy ??
            field.config.files?.previewPolicy ??
            DatabaseFilesPreviewPolicy.Auto,
        },
      };
    case DatabaseFieldKind.UniqueId:
      return {
        uniqueId: {
          prefix: field.config.uniqueId?.prefix ?? "",
          startNumber: field.config.uniqueId?.startNumber ?? 1,
          padding: field.config.uniqueId?.padding ?? 3,
        },
      };
    case DatabaseFieldKind.MultiSelect:
      return {
        multiSelect: {
          options:
            edits.options ??
            field.config.multiSelect?.options.map((option) => ({
              ...option,
            })) ??
            [],
        },
      };
    case DatabaseFieldKind.Tags:
      return {
        tags: {
          maxCount: field.config.tags?.maxCount ?? null,
        },
      };
    case DatabaseFieldKind.Users:
      return {
        users: {
          minCount: field.config.users?.minCount ?? null,
          maxCount: field.config.users?.maxCount ?? null,
        },
      };
    case DatabaseFieldKind.Number:
      return { number: { format: edits.numberFormat?.trim() || null } };
    case DatabaseFieldKind.Percent:
      return {
        percent: {
          minValue: field.config.percent?.minValue ?? null,
          maxValue: field.config.percent?.maxValue ?? null,
        },
      };
    case DatabaseFieldKind.Currency:
      return {
        currency: {
          defaultCurrency: defaultCurrencyForField(field),
          allowCurrencyOverride:
            field.config.currency?.allowCurrencyOverride ?? false,
          minValue: field.config.currency?.minValue ?? null,
          maxValue: field.config.currency?.maxValue ?? null,
        },
      };
    case DatabaseFieldKind.Duration:
      return {
        duration: {
          displayUnit: durationDisplayUnitForField(field),
          minMinutes: field.config.duration?.minMinutes ?? null,
          maxMinutes: field.config.duration?.maxMinutes ?? null,
        },
      };
    case DatabaseFieldKind.Select:
      return {
        select: {
          options:
            edits.options ??
            field.config.select?.options.map((option) => ({ ...option })) ??
            [],
        },
      };
    case DatabaseFieldKind.Status:
      return {
        status: {
          defaultOptionId:
            field.config.status?.defaultOptionId ??
            defaultStatusOptionId(field),
          options:
            edits.options?.map((option) => ({
              ...option,
              group:
                (option as { group?: DatabaseStatusGroup }).group ??
                DatabaseStatusGroup.NotStarted,
            })) ??
            field.config.status?.options.map((option) => ({
              ...option,
            })) ??
            defaultStatusFieldConfigInput().status!.options,
        },
      };
    case DatabaseFieldKind.Text:
      return {
        text: {
          multiline: edits.multiline ?? field.config.text?.multiline ?? false,
        },
      };
    case DatabaseFieldKind.Relation:
      if (!field.config.relation) return null;
      return {
        relation: {
          allowMultiple: field.config.relation.allowMultiple,
          maxTargets: field.config.relation.maxTargets,
          reciprocalFieldId: field.config.relation.reciprocalFieldId,
          targetDatabaseId: field.config.relation.targetDatabaseId,
        },
      };
    case DatabaseFieldKind.Rollup:
      if (!field.config.rollup) return null;
      return {
        rollup: {
          aggregate: field.config.rollup.aggregate,
          emptyValue: field.config.rollup.emptyValue
            ? {
                checkbox: field.config.rollup.emptyValue.checkbox,
                date: field.config.rollup.emptyValue.date
                  ? {
                      start: String(field.config.rollup.emptyValue.date.start),
                      end: field.config.rollup.emptyValue.date.end
                        ? String(field.config.rollup.emptyValue.date.end)
                        : null,
                    }
                  : null,
                number: field.config.rollup.emptyValue.number,
                currency: field.config.rollup.emptyValue.currency
                  ? {
                      amount: field.config.rollup.emptyValue.currency.amount,
                      currencyCode:
                        field.config.rollup.emptyValue.currency.currencyCode,
                    }
                  : null,
                duration: field.config.rollup.emptyValue.duration
                  ? {
                      minutes: field.config.rollup.emptyValue.duration.minutes,
                    }
                  : null,
                text: field.config.rollup.emptyValue.text,
              }
            : null,
          sourceRelationFieldId: field.config.rollup.sourceRelationFieldId,
          stalePolicy: field.config.rollup.stalePolicy,
          targetFieldId: field.config.rollup.targetFieldId,
        },
      };
    case DatabaseFieldKind.Formula:
      if (!field.config.formula) return null;
      return {
        formula: {
          dependencyFieldIds: field.config.formula.dependencyFieldIds,
          expression:
            edits.formulaExpression?.trim() || field.config.formula.expression,
          format: field.config.formula.format,
          resultType:
            edits.formulaResultType ?? field.config.formula.resultType,
          stalePolicy: field.config.formula.stalePolicy,
        },
      };
    case DatabaseFieldKind.Url:
    case DatabaseFieldKind.Email:
    case DatabaseFieldKind.Phone:
    case DatabaseFieldKind.CreatedTime:
    case DatabaseFieldKind.CreatedBy:
    case DatabaseFieldKind.UpdatedTime:
    case DatabaseFieldKind.UpdatedBy:
      return null;
    default:
      return null;
  }
}

function nextOptionId(name: string, position: number) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${slug || "option"}-${position + 1}`;
}

export function selectOptionInputsFromText(
  existingOptions: DatabaseSelectOptionInput[],
  optionText: string,
): DatabaseSelectOptionInput[] {
  return optionText
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, position) => {
      const existing = existingOptions[position];
      return {
        colorRole: existing?.colorRole ?? "neutral",
        id: existing?.id ?? nextOptionId(name, position),
        name,
        position,
      };
    });
}
