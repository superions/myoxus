/**
 * Shared utilities for working with the admin config schema.
 */

import type { AdminConfigSchemaSnapshot } from "./use-admin-config-contract";

/** Server-owned facts needed by the existing specialized config controls. */
export type AdminConfigSchemaField = {
  key: string;
  path: string;
  valueType?: string;
  databaseWritable?: boolean;
  sensitive?: boolean;
  immediate_apply?: boolean | null;
  restart_required?: boolean | null;
  enum?: string[];
  min?: number | null;
  max?: number | null;
};

/**
 * Build a `fieldKey → schemaField` lookup map for one config module.
 *
 * Iterates over all groups in the schema for the given module name and flattens
 * every field into a single Record keyed by `schemaField.key`. Callers can then
 * do `schemaFieldMap[fieldKey]` to obtain placeholder, source, immediate_apply,
 * restart_required, etc.
 *
 * @param schema - The full admin config schema returned by `useAppConfig().schema`.
 * @param moduleName - The module identifier (e.g. `"server"`, `"copilot"`).
 * @returns A map from field key to schema field object.
 */
export function buildSchemaFieldMap(
  schema: AdminConfigSchemaSnapshot | null | undefined,
  moduleName: string,
): Record<string, AdminConfigSchemaField> {
  const map: Record<string, AdminConfigSchemaField> = {};
  for (const schemaModule of schema?.modules ?? []) {
    if (schemaModule.module === moduleName) {
      for (const group of schemaModule.groups ?? []) {
        for (const schemaField of group.fields ?? []) {
          map[schemaField.key] = schemaField as AdminConfigSchemaField;
        }
      }
    }
  }
  return map;
}
