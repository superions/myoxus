// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  databaseDateSourceValue,
  formatCellValue,
  getCellPrimitiveValue,
  getFieldById,
  isDatabaseDateSourceField,
  sortByPosition,
} from "../model";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";

export function getDatabaseDateField(
  record: DatabaseRecord,
  fieldId: string | null | undefined,
) {
  const field = fieldId ? getFieldById(record, fieldId) : undefined;
  return field && isDatabaseDateSourceField(field.fieldType)
    ? field
    : undefined;
}

/** Validate both query axes before loading a damaged schedule configuration.
 * Missing/identical end fields recover through the existing field settings.
 */
export function databaseScheduleFieldsValid(
  record: DatabaseRecord,
  startFieldId: string | null | undefined,
  endFieldId: string | null | undefined,
) {
  const start = getDatabaseDateField(record, startFieldId);
  const end = getDatabaseDateField(record, endFieldId);
  return Boolean(start && (!endFieldId || end) && start.id !== end?.id);
}

export function getFirstDatabaseDateField(record: DatabaseRecord) {
  return sortByPosition(record.fields).find((field) =>
    isDatabaseDateSourceField(field.fieldType),
  );
}

export function getRowDateValue(row: DatabaseRowRecord, field: DatabaseField) {
  return databaseDateSourceValue(getCellPrimitiveValue(row, field));
}

export function formatRowDate(
  row: DatabaseRowRecord,
  field: DatabaseField,
  locale: string,
) {
  return formatCellValue(row, field, locale);
}
