// SPDX-License-Identifier: AGPL-3.0-or-later

import { sortByPosition } from "../model";
import type { DatabaseRowTemplateBinding } from "../types";

type DatabaseRowKind = DatabaseRowTemplateBinding["rowTemplate"]["rowKind"];

/**
 * Returns only templates that can currently create a Row. Keeping this
 * selection shared prevents Table, Kanban and Progress from disagreeing about
 * disabled, detached or reconciliation-blocked bindings.
 */
export function availableDatabaseRowTemplates(
  rowTemplates: DatabaseRowTemplateBinding[],
  rowKind?: DatabaseRowKind,
) {
  return sortByPosition(rowTemplates.map((binding) => binding.rowTemplate))
    .flatMap((template) => {
      const binding = rowTemplates.find(
        (candidate) => candidate.rowTemplate.id === template.id,
      );
      return binding ? [binding] : [];
    })
    .filter(
      (binding) =>
        (!rowKind || binding.rowTemplate.rowKind === rowKind) &&
        binding.rowTemplate.enabled &&
        binding.templateAvailable &&
        !binding.disabled &&
        !binding.archived &&
        !binding.detached &&
        !binding.reconcileRequired,
    );
}

export function defaultDatabaseRowTemplate(
  rowTemplates: DatabaseRowTemplateBinding[],
  rowKind?: DatabaseRowKind,
) {
  const available = availableDatabaseRowTemplates(rowTemplates, rowKind);
  return (
    available.find((binding) => binding.rowTemplate.isDefault) ??
    available[0] ??
    null
  );
}
