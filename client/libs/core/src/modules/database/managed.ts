// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseManagedSchemaReadiness,
  DatabaseProfileKind,
  DatabaseSystemRole,
} from "@myoxus/graphql";

import type { DatabaseField, DatabaseRecord } from "./types";

type ManagedRecord = Pick<DatabaseRecord, "database" | "managedSchema">;
type TaskRecord = ManagedRecord & Pick<DatabaseRecord, "fields">;

/** Structural permissions come from the admitted server descriptor. Generic
 * Databases keep their native controls; actor permissions remain independent.
 */
export function databaseManagedCapabilities(record: ManagedRecord) {
  const managed = record.database.profileKind === DatabaseProfileKind.Project;
  const schema = record.managedSchema;
  const ready =
    !managed || schema?.readiness === DatabaseManagedSchemaReadiness.Ready;
  return {
    managed,
    ready,
    workspaceTasks:
      record.database.systemRole === DatabaseSystemRole.WorkspaceTasks,
    canEditStructure: managed
      ? Boolean(ready && schema?.canEditStructure)
      : true,
    canEditMetadata: managed ? Boolean(ready && schema?.canEditMetadata) : true,
    canManageLifecycle: managed
      ? Boolean(ready && schema?.canManageLifecycle)
      : true,
  };
}

const taskFields = new WeakMap<
  TaskRecord,
  ReadonlyMap<string, DatabaseField>
>();

/** Resolve the guaranteed binding projection once per immutable schema record.
 * Unavailable descriptors never fall back to role/type guesses or local repair.
 */
export function managedTaskFields(record: TaskRecord | null | undefined) {
  if (
    !record ||
    record.managedSchema?.readiness !== DatabaseManagedSchemaReadiness.Ready
  )
    return null;
  const cached = taskFields.get(record);
  if (cached) return cached;
  const byId = new Map(record.fields.map((field) => [field.id, field]));
  const bindings = new Map<string, DatabaseField>();
  for (const binding of record.managedSchema.taskBindings) {
    const field = byId.get(binding.fieldId);
    if (!field) return null;
    bindings.set(binding.roleKey, field);
  }
  taskFields.set(record, bindings);
  return bindings;
}
