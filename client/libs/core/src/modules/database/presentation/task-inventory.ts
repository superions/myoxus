// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AssistantControlKind,
  AssistantValueType,
  type AssistantInputTarget,
  type AssistantPackageFragmentFragment,
} from "@myoxus/graphql";
import {
  assistantTaskFilterTargets,
  assistantText,
  assistantValue,
  assistantVisible,
  resolvedAssistantValue,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "./values";

/** URL/personal native enum values are adapted to authored choice IDs before
 * presentation visibility is evaluated. Hidden groups contribute no controls
 * or native query parameters; this never grants data access. */
export function taskInventoryPresentation(
  descriptor: AssistantPackageFragmentFragment | null | undefined,
  values: Partial<Record<AssistantInputTarget, string | null | undefined>>,
) {
  const supplied: Record<string, ReturnType<typeof assistantValue>> = {};
  for (const input of descriptor?.inputs ?? []) {
    const value = values[input.target];
    const choice =
      value &&
      input.choices.find(
        (choice) =>
          (choice.value.choice ?? choice.value.text)?.toLowerCase() ===
          value.toLowerCase(),
      );
    if (choice)
      supplied[input.id] = assistantValue(AssistantValueType.Choice, {
        choice: choice.id,
      });
  }
  const answers: AssistantAnswers = descriptor
    ? visibleAssistantAnswers(descriptor, supplied, true)
    : {};
  const visibleGroups =
    descriptor?.presentation.steps
      .flatMap((step) => step.groups)
      .filter((group) => assistantVisible(group.visibleWhen, answers)) ?? [];
  const groups = visibleGroups.map((group) => ({
    ...group,
    controls: group.controls.filter((control) => {
      if (control.kind !== AssistantControlKind.TaskFilter || !control.filter)
        return true;
      const target = assistantTaskFilterTargets[control.filter];
      const input = descriptor?.inputs.find((input) => input.target === target);
      return !input || assistantVisible(input.visibleWhen, answers);
    }),
  }));
  const value = (target: AssistantInputTarget) => {
    const input = descriptor?.inputs.find((input) => input.target === target);
    return input
      ? (resolvedAssistantValue(input, answers)?.choice ??
          resolvedAssistantValue(input, answers)?.text)
      : undefined;
  };
  const label = (target: AssistantInputTarget, language: string) => {
    const input = descriptor?.inputs.find((input) => input.target === target);
    const selected = input?.choices.find(
      (choice) => choice.id === answers[input.id]?.choice,
    );
    return selected ? assistantText(selected.label, language) : undefined;
  };
  return {
    answers,
    groups,
    controls: groups.flatMap((group) => group.controls),
    value,
    label,
  };
}

/** Optional display state belongs to the Workbench URL, never a persisted
 * Database View or a schema/Row read for each inventory entry. */
export function taskInventoryDisplay(values: readonly string[]) {
  return {
    assignees: values.includes("assignees"),
    priority: values.includes("priority"),
  };
}
