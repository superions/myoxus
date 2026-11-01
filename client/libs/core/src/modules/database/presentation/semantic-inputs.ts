// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AssistantInputTarget,
  type AssistantPackageFragmentFragment as AssistantPackageFragment,
  type AssistantValueFragmentFragment as AssistantValueFragment,
} from "@myoxus/graphql";
import {
  assistantVisible,
  assistantInputIsPlaced,
  visibleAssistantAnswers,
  type AssistantAnswers,
} from "./values";

export type AssistantSemanticValues = Partial<
  Record<AssistantInputTarget, AssistantValueFragment>
>;

/** Targets name implemented native inputs, never a particular package/input ID.
 * Visibility pruning prevents a hidden old draft from reaching native apply. */
export function semanticAssistantAnswers(
  descriptor: AssistantPackageFragment,
  values: AssistantSemanticValues,
): AssistantAnswers {
  const answers: Record<string, AssistantValueFragment> = {};
  for (const input of descriptor.inputs) {
    const value = values[input.target];
    if (value) answers[input.id] = value;
  }
  return visibleAssistantAnswers(descriptor, answers);
}

export function visibleAssistantTargets(
  descriptor: AssistantPackageFragment,
  answers: AssistantAnswers,
) {
  const visible = visibleAssistantAnswers(descriptor, answers);
  return new Set(
    descriptor.inputs
      .filter(
        (input) =>
          assistantInputIsPlaced(descriptor, input, visible) &&
          assistantVisible(input.visibleWhen, visible),
      )
      .map((input) => input.target),
  );
}
