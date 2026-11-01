// SPDX-License-Identifier: AGPL-3.0-or-later

import type { useI18n } from "@myoxus/i18n";

import { managedTaskFields } from "../managed";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";

type I18nShape = ReturnType<typeof useI18n>;
type Label = (t: I18nShape) => string;

const fieldLabels: Readonly<Record<string, Label>> = {
  "task.title": (t) => t.Title(),
  "task.description": (t) => t["com.myoxus.common.description"](),
  "task.status": (t) => t.Status(),
  "task.priority": (t) => t["com.myoxus.database.property.priority"](),
  "task.tags": (t) => t.Tags(),
  "task.owner": (t) => t.Owner(),
  "task.assignees": (t) => t["com.myoxus.database.property.assignees"](),
  "task.assignedBy": (t) => t["com.myoxus.common.assigned-by"](),
  "task.progress": (t) => t["com.myoxus.common.progress"](),
  "task.publicId": (t) => t["com.myoxus.common.task-id"](),
  "task.complexity": (t) => t["com.myoxus.common.complexity"](),
  "task.effort": (t) => t["com.myoxus.common.effort"](),
  "task.cost": (t) => t["com.myoxus.common.cost"](),
  "task.startDate": (t) => t["com.myoxus.common.start-date"](),
  "task.dueDate": (t) => t["com.myoxus.database.property.due"](),
  "task.completedAt": (t) => t["com.myoxus.common.completed-at"](),
  "task.completedBy": (t) => t["com.myoxus.common.completed-by"](),
  "task.attachments": (t) => t["com.myoxus.common.attachments"](),
  "task.document": (t) => t["com.myoxus.common.linked-document"](),
  "task.parent": (t) => t["com.myoxus.database.task-parent.label"](),
  "task.phase": (t) => t["com.myoxus.database.property.phase"](),
  "task.milestone": (t) => t["com.myoxus.editor.mermaid.gantt-milestone"](),
  "task.dependencies": (t) => t["com.myoxus.common.dependencies"](),
  "task.blockedBy": (t) => t["com.myoxus.database.task-blocking.blocked-by"](),
  "task.watchers": (t) => t["com.myoxus.common.watchers"](),
  "task.acceptanceCriteria": (t) =>
    t["com.myoxus.common.acceptance-criteria"](),
};

const optionLabels: Readonly<Record<string, Readonly<Record<string, Label>>>> =
  {
    "task.status": {
      "status.todo": (t) => t["com.myoxus.common.status.todo"](),
      "status.in_progress": (t) => t["com.myoxus.common.status.in-progress"](),
      "status.done": (t) => t["com.myoxus.common.status.completed"](),
    },
    "task.priority": {
      "priority.lowest": (t) => t["com.myoxus.common.priority.lowest"](),
      "priority.low": (t) => t["com.myoxus.common.priority.low"](),
      "priority.normal": (t) => t["com.myoxus.common.priority.normal"](),
      "priority.high": (t) => t["com.myoxus.common.priority.high"](),
      "priority.critical": (t) => t["com.myoxus.common.priority.critical"](),
    },
    "task.complexity": {
      "complexity.trivial": (t) => t["com.myoxus.common.complexity.trivial"](),
      "complexity.simple": (t) => t["com.myoxus.common.complexity.simple"](),
      "complexity.moderate": (t) =>
        t["com.myoxus.common.complexity.moderate"](),
      "complexity.complex": (t) => t["com.myoxus.common.complexity.complex"](),
      "complexity.very_complex": (t) =>
        t["com.myoxus.common.complexity.very-complex"](),
    },
  };

function taskRole(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
  field: DatabaseField,
) {
  if (!record.managedSchema || row.row.rowKind !== "task") return null;
  for (const [role, binding] of managedTaskFields(record) ?? []) {
    if (binding.id === field.id) return role;
  }
  return null;
}

/** Managed Tasks have a fixed vocabulary. Schema additions must supply a
 * translation instead of exposing stored names; other Database rows retain
 * their authored labels. This projection never changes persisted metadata. */
export function databaseFieldDisplayName(
  t: I18nShape,
  record: DatabaseRecord,
  row: DatabaseRowRecord,
  field: DatabaseField,
) {
  const role = taskRole(record, row, field);
  if (role === null) return field.name;
  const label = fieldLabels[role];
  if (!label)
    throw new Error(`Missing managed Task field translation: ${role}`);
  return label(t);
}

export function taskOptionDisplayName(
  t: I18nShape,
  role: string,
  optionId: string,
) {
  const label = optionLabels[role]?.[optionId];
  if (!label)
    throw new Error(
      `Missing managed Task option translation: ${role}/${optionId}`,
    );
  return label(t);
}

export function databaseOptionDisplayName(
  t: I18nShape,
  record: DatabaseRecord,
  row: DatabaseRowRecord,
  field: DatabaseField,
  option: { id: string; name: string },
) {
  const role = taskRole(record, row, field);
  return role === null
    ? option.name
    : taskOptionDisplayName(t, role, option.id);
}
