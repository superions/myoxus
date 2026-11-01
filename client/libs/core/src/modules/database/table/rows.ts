// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Myoxus-owned Database Table row / template descriptors (P-DB-29B-B).

import type { DatabaseRowRecord, DatabaseRowTemplateBinding } from "../types";
import type {
  DatabaseTableRowDescriptor,
  DatabaseTableRowTemplateDescriptor,
} from "./types";

export function databaseTableRowDescriptors(
  rows: DatabaseRowRecord[],
): DatabaseTableRowDescriptor[] {
  return rows.map((row) => ({
    id: row.row.id,
    title: row.row.title,
    contentDocument: row.row.contentDocument,
    redacted: row.redacted,
  }));
}

export function databaseTableRowTemplateDescriptors(
  rowTemplates: DatabaseRowTemplateBinding[],
): DatabaseTableRowTemplateDescriptor[] {
  return rowTemplates
    .filter((binding) => binding.rowTemplate.enabled)
    .map((binding) => ({
      id: binding.rowTemplate.id,
      label: binding.rowTemplate.isDefault
        ? `${binding.rowTemplate.name} · Default`
        : binding.rowTemplate.name,
      available: binding.templateAvailable,
      isDefault: binding.rowTemplate.isDefault,
    }));
}
