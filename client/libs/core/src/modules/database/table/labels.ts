// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Myoxus-owned Database Table labels (P-DB-29B-B).
//
// Maps the existing `DatabaseFieldKind` enum onto the
// `com.myoxus.database.field.type.<kind>` i18n strings and produces the
// `DatabaseTableFieldDescriptor` / `DatabaseTableFieldTypeLabels` /
// `DatabaseTableLabels` shapes consumed by the active Table surface.
// These helpers replace the equivalent helpers that previously lived
// in the host module and must not import any legacy data-view module.

import { DatabaseFieldKind } from "@myoxus/graphql";
import type { useI18n } from "@myoxus/i18n";

import { isDatabaseProjectionField } from "../model";
import type { DatabaseField } from "../types";
import type {
  DatabaseTableFieldDescriptor,
  DatabaseTableFieldTypeLabels,
  DatabaseTableLabels,
} from "./types";

type I18nShape = ReturnType<typeof useI18n>;

const READONLY_FIELD_KINDS = new Set<DatabaseFieldKind>([
  DatabaseFieldKind.UniqueId,
  DatabaseFieldKind.Rollup,
  DatabaseFieldKind.Formula,
  DatabaseFieldKind.CreatedTime,
  DatabaseFieldKind.CreatedBy,
  DatabaseFieldKind.UpdatedTime,
  DatabaseFieldKind.UpdatedBy,
]);

const SUPPORTED_TABLE_FIELD_KINDS = new Set<DatabaseFieldKind>([
  DatabaseFieldKind.Checkbox,
  DatabaseFieldKind.CreatedBy,
  DatabaseFieldKind.CreatedTime,
  DatabaseFieldKind.Currency,
  DatabaseFieldKind.Date,
  DatabaseFieldKind.DateTime,
  DatabaseFieldKind.DocumentLink,
  DatabaseFieldKind.Duration,
  DatabaseFieldKind.Email,
  DatabaseFieldKind.Files,
  DatabaseFieldKind.Formula,
  DatabaseFieldKind.MultiSelect,
  DatabaseFieldKind.Tags,
  DatabaseFieldKind.Number,
  DatabaseFieldKind.Percent,
  DatabaseFieldKind.Phone,
  DatabaseFieldKind.Relation,
  DatabaseFieldKind.RichText,
  DatabaseFieldKind.Rollup,
  DatabaseFieldKind.Select,
  DatabaseFieldKind.Status,
  DatabaseFieldKind.Text,
  DatabaseFieldKind.Title,
  DatabaseFieldKind.UniqueId,
  DatabaseFieldKind.UpdatedBy,
  DatabaseFieldKind.UpdatedTime,
  DatabaseFieldKind.Url,
  DatabaseFieldKind.User,
  DatabaseFieldKind.Users,
]);

/** Field kinds with a production Table renderer/editor contract. */
export function isDatabaseTableFieldSupported(
  fieldType: DatabaseFieldKind,
): boolean {
  return SUPPORTED_TABLE_FIELD_KINDS.has(fieldType);
}

export function isDatabaseTableFieldReadonly(field: DatabaseField): boolean {
  if (field.fieldType === DatabaseFieldKind.Title) return false;
  return (
    !isDatabaseTableFieldSupported(field.fieldType) ||
    READONLY_FIELD_KINDS.has(field.fieldType) ||
    isDatabaseProjectionField(field.fieldType)
  );
}

/** Per-cell-type label resolver used by the field-type selection menu. */
export function databaseTableFieldTypeLabel(
  t: I18nShape,
  kind: DatabaseFieldKind,
): string {
  switch (kind) {
    case DatabaseFieldKind.Checkbox:
      return t["com.myoxus.database.field.type.checkbox"]();
    case DatabaseFieldKind.CreatedBy:
      return t["com.myoxus.database.field.type.created-by"]();
    case DatabaseFieldKind.CreatedTime:
      return t["com.myoxus.database.field.type.created-time"]();
    case DatabaseFieldKind.Date:
      return t["com.myoxus.database.field.type.date"]();
    case DatabaseFieldKind.DateTime:
      return t["com.myoxus.database.field.type.date-time"]();
    case DatabaseFieldKind.Files:
      return t["com.myoxus.database.field.type.files"]();
    case DatabaseFieldKind.RichText:
      return t["com.myoxus.database.field.type.rich-text"]();
    case DatabaseFieldKind.UniqueId:
      return t["com.myoxus.database.field.type.unique-id"]();
    case DatabaseFieldKind.Email:
      return t["com.myoxus.database.field.type.email"]();
    case DatabaseFieldKind.Formula:
      return t["com.myoxus.database.field.type.formula"]();
    case DatabaseFieldKind.MultiSelect:
      return t["com.myoxus.database.field.type.multi-select"]();
    case DatabaseFieldKind.Tags:
      return t["Tags"]();
    case DatabaseFieldKind.Number:
      return t["com.myoxus.database.field.type.number"]();
    case DatabaseFieldKind.Percent:
      return t["com.myoxus.database.field.type.percent"]();
    case DatabaseFieldKind.Currency:
      return t["com.myoxus.database.field.type.currency"]();
    case DatabaseFieldKind.Duration:
      return t["com.myoxus.database.field.type.duration"]();
    case DatabaseFieldKind.Phone:
      return t["com.myoxus.database.field.type.phone"]();
    case DatabaseFieldKind.Relation:
      return t["com.myoxus.database.field.type.relation"]();
    case DatabaseFieldKind.Rollup:
      return t["com.myoxus.database.field.type.rollup"]();
    case DatabaseFieldKind.Select:
      return t["com.myoxus.database.field.type.select"]();
    case DatabaseFieldKind.Status:
      return t["com.myoxus.database.field.type.status"]();
    case DatabaseFieldKind.Text:
      return t["com.myoxus.database.field.type.text"]();
    case DatabaseFieldKind.Title:
      return t["com.myoxus.database.field.type.title"]();
    case DatabaseFieldKind.UpdatedBy:
      return t["com.myoxus.database.field.type.updated-by"]();
    case DatabaseFieldKind.UpdatedTime:
      return t["com.myoxus.database.field.type.updated-time"]();
    case DatabaseFieldKind.Url:
      return t["com.myoxus.database.field.type.url"]();
    case DatabaseFieldKind.User:
      return t["com.myoxus.database.field.type.user"]();
    case DatabaseFieldKind.Users:
      return t["com.myoxus.database.field.type.users"]();
    default:
      return t["com.myoxus.database.field.type.unsupported"]();
  }
}

export function databaseTableFieldDescriptors(
  fields: DatabaseField[],
  fieldWidths: ReadonlyArray<{ fieldId: string; width: number }>,
  t: I18nShape,
): DatabaseTableFieldDescriptor[] {
  const widthsByFieldId = new Map(
    fieldWidths.map((fieldWidth) => [fieldWidth.fieldId, fieldWidth.width]),
  );
  return fields.map((field) => ({
    id: field.id,
    fieldType: field.fieldType,
    label: field.name,
    readonly: isDatabaseTableFieldReadonly(field),
    typeLabel: databaseTableFieldTypeLabel(t, field.fieldType),
    unsupported: !isDatabaseTableFieldSupported(field.fieldType),
    width: widthsByFieldId.get(field.id) ?? null,
    sortDirection: null,
    sortPriority: null,
  }));
}

export function databaseTableFieldTypeLabels(
  t: I18nShape,
): DatabaseTableFieldTypeLabels {
  return {
    Checkbox: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Checkbox),
    CreatedBy: databaseTableFieldTypeLabel(t, DatabaseFieldKind.CreatedBy),
    CreatedTime: databaseTableFieldTypeLabel(t, DatabaseFieldKind.CreatedTime),
    Date: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Date),
    DateTime: databaseTableFieldTypeLabel(t, DatabaseFieldKind.DateTime),
    Email: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Email),
    Files: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Files),
    UniqueId: databaseTableFieldTypeLabel(t, DatabaseFieldKind.UniqueId),
    Formula: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Formula),
    MultiSelect: databaseTableFieldTypeLabel(t, DatabaseFieldKind.MultiSelect),
    Tags: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Tags),
    Status: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Status),
    Number: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Number),
    Percent: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Percent),
    Currency: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Currency),
    Duration: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Duration),
    Phone: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Phone),
    Relation: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Relation),
    RichText: databaseTableFieldTypeLabel(t, DatabaseFieldKind.RichText),
    Rollup: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Rollup),
    Select: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Select),
    Text: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Text),
    Title: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Title),
    UpdatedBy: databaseTableFieldTypeLabel(t, DatabaseFieldKind.UpdatedBy),
    UpdatedTime: databaseTableFieldTypeLabel(t, DatabaseFieldKind.UpdatedTime),
    Url: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Url),
    User: databaseTableFieldTypeLabel(t, DatabaseFieldKind.User),
    Users: databaseTableFieldTypeLabel(t, DatabaseFieldKind.Users),
    Unsupported: t["com.myoxus.database.field.type.unsupported"](),
  };
}

export function databaseTableLabels(
  t: I18nShape,
  emptyRows?: string,
): DatabaseTableLabels {
  return {
    cancel: t["Cancel"](),
    bulkActionsTitle: t["com.myoxus.database.bulk.actions.title"](),
    bulkEdit: t["com.myoxus.database.bulk.action.edit"](),
    bulkDelete: t["com.myoxus.database.bulk.action.delete"](),
    bulkDeleteConfirmBody: t["com.myoxus.database.bulk.confirm.delete.body"](),
    bulkDeleteConfirmConfirm:
      t["com.myoxus.database.bulk.confirm.delete.confirm"](),
    bulkDeleteConfirmTitle: (count) =>
      t["com.myoxus.database.bulk.confirm.delete.title"]({
        count: String(count),
      }),
    bulkExportSelected: t["com.myoxus.database.bulk.action.exportSelected"](),
    bulkSelectedCount: (count) =>
      t["com.myoxus.database.bulk.selectedCount"]({ count: String(count) }),
    clearSelection: t["com.myoxus.editCollection.pages.clear"](),
    createField: t["com.myoxus.database.field.create"](),
    databaseMenu: t["com.myoxus.database.database.menu"](),
    deleteField: t["com.myoxus.database.field.delete"](),
    deleteRow: t["com.myoxus.database.row.delete"](),
    emptyRows: emptyRows ?? t["com.myoxus.database.row.empty"](),
    fieldCreateValidation:
      t["com.myoxus.database.field.create-name-required"](),
    fieldConfigure: t["com.myoxus.database.field.configure"](),
    fieldName: t["com.myoxus.database.field.name"](),
    fieldPlus: t["com.myoxus.database.field.add"](),
    fieldMoveLeft: t["com.myoxus.database.field.move-left"](),
    fieldMoveRight: t["com.myoxus.database.field.move-right"](),
    fieldReorder: t["com.myoxus.database.field.reorder"](),
    fieldResize: t["com.myoxus.database.field.resize"](),
    fieldType: t["com.myoxus.database.field.type"](),
    manageRowTemplates: t["com.myoxus.database.rowTemplate.manage"](),
    newRow: t["com.myoxus.database.row.add"](),
    openRowDetails: t["com.myoxus.database.row.open-details"](),
    rowMenu: t["com.myoxus.database.row.menu"](),
    selectAllRows: t["admin.common.select-row"](),
    selectRow: t["admin.common.select-row"](),
    sortAscending: t["com.myoxus.database.view.sort-ascending"](),
    sortDescending: t["com.myoxus.database.view.sort-descending"](),
    unsupportedField: t["com.myoxus.database.field.unsupported"](),
    useEmptyRow: t["com.myoxus.database.row.empty-create"](),
    viewMenu: t["com.myoxus.database.view.actions"](),
  };
}
