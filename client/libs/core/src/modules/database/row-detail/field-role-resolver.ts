// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseFieldKind, DatabaseProfileKind } from "@myoxus/graphql";

import { managedTaskFields } from "../managed";
import {
  getCellPrimitiveValue,
  getCellValue,
  getTitleField,
  sortByPosition,
} from "../model";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";

type FieldRole = DatabaseRecord["fieldRoles"][number];

export type DatabaseRowFieldLayout = {
  titleField: DatabaseField;
  descriptionField: DatabaseField | null;
  workflowFields: DatabaseField[];
  detailFields: DatabaseField[];
  moreFields: DatabaseField[];
  roleByFieldId: ReadonlyMap<string, FieldRole>;
};

function roleField(
  fieldsById: ReadonlyMap<string, DatabaseField>,
  rolesByKey: ReadonlyMap<string, FieldRole>,
  roleKey: string,
) {
  const fieldId = rolesByKey.get(roleKey)?.fieldId;
  return fieldId ? (fieldsById.get(fieldId) ?? null) : null;
}

/** Ready managed Task bindings are authoritative; unavailable schemas have no
 * guessed relation editor or local repair path. */
export function resolveTaskParentProperty(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
) {
  if (
    row.row.rowKind !== "task" ||
    record.database.profileKind !== DatabaseProfileKind.Project
  )
    return null;
  return {
    field: managedTaskFields(record)?.get("task.parent") ?? null,
    aliased: false,
  };
}

export function resolveTaskBlockedByProperty(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
) {
  if (
    row.row.rowKind !== "task" ||
    record.database.profileKind !== DatabaseProfileKind.Project
  )
    return null;
  return {
    field: managedTaskFields(record)?.get("task.blockedBy") ?? null,
    aliased: false,
  };
}

/**
 * Resolves row-detail structure only from server-owned role and row-kind
 * metadata. Field names and positions remain a deterministic fallback for
 * Generic Databases, never an implicit Project semantic contract. Callers admit
 * managed records through readiness before mounting native Row content.
 */
export function resolveDatabaseRowFieldLayout(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
): DatabaseRowFieldLayout {
  const orderedFields = sortByPosition(record.fields);
  const fallbackTitle = getTitleField(record);
  if (record.database.profileKind !== DatabaseProfileKind.Project) {
    const remaining = orderedFields.filter(
      (field) => field.id !== fallbackTitle.id,
    );
    const descriptionField =
      remaining.find(
        (field) => field.fieldType === DatabaseFieldKind.RichText,
      ) ?? null;
    const detailFields = remaining.filter(
      (field) =>
        field.id !== descriptionField?.id &&
        Boolean(getCellValue(row, field.id)),
    );
    const moreFields = remaining.filter(
      (field) =>
        field.id !== descriptionField?.id && !getCellValue(row, field.id),
    );
    return {
      titleField: fallbackTitle,
      descriptionField,
      workflowFields: [],
      detailFields,
      moreFields,
      roleByFieldId: new Map(),
    };
  }

  const bindings = managedTaskFields(record);
  const scopedRoles = record.fieldRoles.filter((role) =>
    row.row.rowKind === "task"
      ? bindings?.get(role.roleKey)?.id === role.fieldId &&
        role.rowKindScope === "task"
      : role.rowKindScope === row.row.rowKind,
  );
  const rolesByKey = new Map(scopedRoles.map((role) => [role.roleKey, role]));
  const roleByFieldId = new Map(
    scopedRoles
      .filter(
        (role) =>
          role.roleKey !== "task.parent" && role.roleKey !== "task.blockedBy",
      )
      .map((role) => [role.fieldId, role]),
  );
  for (const role of scopedRoles) {
    if (
      (role.roleKey === "task.parent" || role.roleKey === "task.blockedBy") &&
      !roleByFieldId.has(role.fieldId)
    )
      roleByFieldId.set(role.fieldId, role);
  }
  const fieldsById = new Map(orderedFields.map((field) => [field.id, field]));
  const rowKind = row.row.rowKind;
  const titleField =
    rowKind === "task"
      ? bindings!.get("task.title")!
      : (roleField(fieldsById, rolesByKey, `${rowKind}.title`) ??
        fallbackTitle);
  const descriptionField =
    rowKind === "task"
      ? (bindings?.get("task.description") ?? null)
      : roleField(fieldsById, rolesByKey, `${rowKind}.description`);

  const consumedFieldIds = new Set([
    titleField.id,
    ...(descriptionField ? [descriptionField.id] : []),
  ]);
  const remainingScopedFields = orderedFields.filter(
    (field) => roleByFieldId.has(field.id) && !consumedFieldIds.has(field.id),
  );
  const candidateDetails = remainingScopedFields;
  // Parent has one stable dedicated owner; canonical Cell delivery must not
  // move it between optional property accordions.
  const isParentProperty = (field: DatabaseField) =>
    rowKind === "task" &&
    roleByFieldId.get(field.id)?.roleKey === "task.parent";
  // Blocked by is consumed once by the stable dedicated Task section.
  const isBlockedByProperty = (field: DatabaseField) =>
    rowKind === "task" &&
    roleByFieldId.get(field.id)?.roleKey === "task.blockedBy";

  return {
    titleField,
    descriptionField,
    workflowFields: [],
    detailFields: candidateDetails.filter(
      (field) =>
        !isParentProperty(field) &&
        !isBlockedByProperty(field) &&
        Boolean(getCellValue(row, field.id)),
    ),
    moreFields: candidateDetails.filter(
      (field) =>
        !isParentProperty(field) &&
        !isBlockedByProperty(field) &&
        !getCellValue(row, field.id),
    ),
    roleByFieldId,
  };
}

/** Stored empty Cells are not populated properties. Keep numeric zero while
 * treating empty native text, rich text, reference arrays and unset values as
 * absent; schema role requiredness does not require a Task Cell value. */
export function hasMeaningfulTaskValue(
  row: DatabaseRowRecord,
  field: DatabaseField,
) {
  const value = getCellPrimitiveValue(row, field);
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (field.fieldType === DatabaseFieldKind.RichText)
    return Boolean((value as { plainText?: string | null }).plainText?.trim());
  if (typeof value === "boolean") return value;
  return true;
}
