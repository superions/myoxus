// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AssistantFolderDestinationKind,
  AssistantControlKind,
  AssistantInputTarget,
  AssistantTaskFilter,
  type AssistantPackageFragmentFragment as AssistantPackageFragment,
  AssistantValueType,
  AssistantVisibilityKind,
  type AssistantInputFragmentFragment as AssistantInputFragment,
  type AssistantGroupFragmentFragment as AssistantGroupFragment,
  type AssistantVisibilityFragmentFragment as AssistantVisibilityFragment,
  type AssistantLocalizedTextFragmentFragment as AssistantLocalizedTextFragment,
  type AssistantValueFragmentFragment as AssistantValueFragment,
} from "@myoxus/graphql";

export type AssistantAnswers = Readonly<Record<string, AssistantValueFragment>>;

/** Match the existing i18n language/base-language/English fallback for the
 * package's four authored translations; offering IDs never select copy. */
export function assistantText(
  text: AssistantLocalizedTextFragment,
  language: string,
) {
  switch (language.split("-")[0]) {
    case "de":
      return text.de;
    case "fr":
      return text.fr;
    case "es":
      return text.es;
    default:
      return text.en;
  }
}

export function assistantValue(
  kind: AssistantValueType,
  payload: Partial<Omit<AssistantValueFragment, "kind">>,
): AssistantValueFragment {
  return {
    taskReferences: null,
    documentId: null,
    text: null,
    boolean: null,
    choice: null,
    choices: null,
    date: null,
    dateTime: null,
    memberIds: null,
    databaseId: null,
    rowTemplateId: null,
    rowId: null,
    rowSelection: null,
    folder: null,
    ...payload,
    kind,
  };
}

/** Compare the typed value, not transport-only null fields or object key order. */
export function assistantValueContent(value: AssistantValueFragment) {
  switch (value.kind) {
    case AssistantValueType.TaskReferences:
      return value.taskReferences?.map(({ databaseId, rowId }) => ({
        databaseId,
        rowId,
      }));
    case AssistantValueType.Document:
      return value.documentId;
    case AssistantValueType.Text:
      return value.text;
    case AssistantValueType.Boolean:
      return value.boolean;
    case AssistantValueType.Choice:
      return value.choice;
    case AssistantValueType.Choices:
      return value.choices;
    case AssistantValueType.Date:
      return value.date;
    case AssistantValueType.DateTime:
      return value.dateTime;
    case AssistantValueType.Members:
      return value.memberIds;
    case AssistantValueType.DatabaseDestination:
      return value.databaseId;
    case AssistantValueType.RowTemplate:
      return value.rowTemplateId;
    case AssistantValueType.Row:
      return value.rowId;
    case AssistantValueType.RowSelection:
      return value.rowSelection;
    case AssistantValueType.Folder:
      return value.folder
        ? value.folder.kind === AssistantFolderDestinationKind.Existing
          ? { kind: "existing", id: value.folder.id }
          : {
              kind: "new",
              name: value.folder.name,
              parent: value.folder.parent,
            }
        : null;
  }
}

function orderedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedValue);
  if (value instanceof Date) return value.toJSON();
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, orderedValue(value)]),
    );
  return value;
}

export function assistantValuesEqual(
  left: AssistantValueFragment,
  right: AssistantValueFragment,
) {
  return (
    left.kind === right.kind &&
    JSON.stringify(orderedValue(assistantValueContent(left))) ===
      JSON.stringify(orderedValue(assistantValueContent(right)))
  );
}

/** This is presentation visibility only. Native prepare repeats pruning,
 * normalization and validation before any write. Explicit false/empty-list
 * answers are present; a blank Text answer is not. */
export function assistantVisible(
  rule: AssistantVisibilityFragment | null | undefined,
  answers: AssistantAnswers,
) {
  if (!rule) return true;
  const actual = answers[rule.input];
  if (!actual) return false;
  if (rule.kind === AssistantVisibilityKind.Present)
    return (
      actual.kind !== AssistantValueType.Text || Boolean(actual.text?.trim())
    );
  return Boolean(rule.value && assistantValuesEqual(actual, rule.value));
}

export const assistantTaskFilterTargets: Partial<
  Record<AssistantTaskFilter, AssistantInputTarget>
> = {
  [AssistantTaskFilter.Scope]: AssistantInputTarget.TaskScope,
  [AssistantTaskFilter.Lifecycle]: AssistantInputTarget.TaskLifecycle,
  [AssistantTaskFilter.DuePreset]: AssistantInputTarget.TaskDuePreset,
  [AssistantTaskFilter.Search]: AssistantInputTarget.TaskSearch,
  [AssistantTaskFilter.Assignee]: AssistantInputTarget.TaskAssignee,
  [AssistantTaskFilter.StatusGroup]: AssistantInputTarget.TaskStatusGroup,
  [AssistantTaskFilter.BlockedOnly]: AssistantInputTarget.TaskBlockedOnly,
  [AssistantTaskFilter.Destination]: AssistantInputTarget.Destination,
};

export function assistantInputIsPlaced(
  descriptor: AssistantPackageFragment,
  input: AssistantInputFragment,
  answers: AssistantAnswers,
) {
  return [...descriptor.presentation.steps, ...descriptor.presentation.dialogs]
    .flatMap((item) => item.groups)
    .some(
      (group) =>
        assistantVisible(group.visibleWhen, answers) &&
        group.controls.some(
          (control) =>
            (control.kind === AssistantControlKind.Input &&
              control.input === input.id) ||
            (control.kind === AssistantControlKind.TaskFilter &&
              control.filter &&
              assistantTaskFilterTargets[control.filter] === input.target),
        ),
    );
}

export function visibleAssistantAnswers(
  descriptor: AssistantPackageFragment,
  answers: AssistantAnswers,
  defaults = false,
): AssistantAnswers {
  const visible: Record<string, AssistantValueFragment> = {};
  for (const input of descriptor.inputs) {
    if (
      !assistantVisible(input.visibleWhen, visible) ||
      !assistantInputIsPlaced(descriptor, input, visible)
    )
      continue;
    const value = answers[input.id] ?? (defaults ? input.defaultValue : null);
    if (value)
      visible[input.id] =
        value.kind === AssistantValueType.Text
          ? { ...value, text: value.text?.trim() ?? "" }
          : value;
  }
  return visible;
}

export function assistantRequiredInputIds(
  descriptor: AssistantPackageFragment,
  groups: readonly AssistantGroupFragment[],
  answers: AssistantAnswers,
) {
  const normalized = visibleAssistantAnswers(descriptor, answers);
  const inputs = groups
    .filter((group) => assistantVisible(group.visibleWhen, normalized))
    .flatMap((group) => group.controls)
    .flatMap((control) =>
      control.kind === AssistantControlKind.Input && control.input
        ? [control.input]
        : [],
    );
  return [...new Set(inputs)].filter((id) => {
    const input = descriptor.inputs.find((input) => input.id === id);
    if (!input?.required || !assistantVisible(input.visibleWhen, normalized))
      return false;
    const value = normalized[id];
    return (
      !value ||
      (value.kind === AssistantValueType.TaskReferences &&
        !value.taskReferences?.length) ||
      (value.kind === AssistantValueType.Document && !value.documentId) ||
      (value.kind === AssistantValueType.Text && !value.text?.trim()) ||
      (value.kind === AssistantValueType.Members && !value.memberIds?.length) ||
      (value.kind === AssistantValueType.Choices && !value.choices?.length)
    );
  });
}

/** Prune hidden draft slots without trimming the visible text being edited.
 * Canonical normalization is used for visibility and again before preparation;
 * spaces typed between words must remain in the native input draft. */
export function pruneAssistantDraft(
  descriptor: AssistantPackageFragment,
  answers: AssistantAnswers,
): AssistantAnswers {
  const normalized = visibleAssistantAnswers(descriptor, answers);
  return Object.fromEntries(
    Object.keys(normalized).map((key) => [key, answers[key]]),
  );
}

/** The API deliberately accepts the native tagged value map as bounded JSON.
 * Serialize only the selected payload, never transport-only nullable fields. */
export function assistantAnswerPayload(answers: AssistantAnswers) {
  return Object.fromEntries(
    Object.entries(answers).map(([input, value]) => [
      input,
      {
        kind: value.kind[0].toLowerCase() + value.kind.slice(1),
        value:
          value.kind === AssistantValueType.RowSelection
            ? value.rowSelection?.map((row) => ({
                rowId: row.rowId,
                expectedEditRevision: row.expectedEditRevision,
                cellRevisions: Object.fromEntries(
                  row.cellRevisions.map((cell) => [
                    cell.fieldId,
                    cell.expectedEditRevision,
                  ]),
                ),
              }))
            : assistantValueContent(value),
      },
    ]),
  );
}

/** Choice answers carry authored choice IDs. Their payload is resolved only
 * when adapting an admitted semantic target, matching native preparation. */
export function resolvedAssistantValue(
  input: AssistantInputFragment,
  answers: AssistantAnswers,
) {
  const value = answers[input.id];
  return value?.kind === AssistantValueType.Choice
    ? input.choices.find((choice) => choice.id === value.choice)?.value
    : value;
}
