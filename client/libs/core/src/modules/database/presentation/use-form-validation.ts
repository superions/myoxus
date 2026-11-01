// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AssistantControlKind,
  type AssistantGroupFragmentFragment,
  type AssistantPackageFragmentFragment,
} from "@myoxus/graphql";
import { useRef, useState } from "react";
import { assistantRequiredInputIds, type AssistantAnswers } from "./values";

/** Source-required feedback belongs to the native form, not to write replay or
 * server eligibility. Every mutation keeps its existing controller guards. */
export function useAssistantFormValidation<
  T extends HTMLElement = HTMLFormElement,
>(
  descriptor: AssistantPackageFragmentFragment | null | undefined,
  answers: AssistantAnswers,
) {
  const formRef = useRef<T>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [checkedInputs, setCheckedInputs] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const groups = descriptor
    ? [
        ...descriptor.presentation.steps,
        ...descriptor.presentation.dialogs,
      ].flatMap((item) => item.groups)
    : [];
  const invalidInputs = new Set(
    descriptor
      ? assistantRequiredInputIds(descriptor, groups, answers).filter((id) =>
          checkedInputs.has(id),
        )
      : [],
  );
  const validate = (
    currentGroups: readonly AssistantGroupFragmentFragment[] = groups,
  ) => {
    if (!descriptor) return false;
    const missing = assistantRequiredInputIds(
      descriptor,
      currentGroups,
      answers,
    );
    // A step check must not mark untouched fields in a later step or dialog.
    const tested = currentGroups.flatMap((group) =>
      group.controls.flatMap((control) =>
        control.kind === AssistantControlKind.Input && control.input
          ? [control.input]
          : [],
      ),
    );
    setCheckedInputs((previous) => new Set([...previous, ...tested]));
    if (!missing.length) return true;
    const selector = `[data-assistant-input="${CSS.escape(missing[0])}"]`;
    const root =
      dialogRef.current?.querySelector<HTMLElement>(selector) ??
      formRef.current?.querySelector<HTMLElement>(selector);
    const input = root?.matches("input,textarea,button,[role=combobox]")
      ? root
      : root?.querySelector<HTMLElement>(
          "input,textarea,button,[role=combobox]",
        );
    input?.focus();
    return false;
  };
  return {
    formRef,
    dialogRef,
    invalidInputs,
    validate,
    reset: () => setCheckedInputs(new Set()),
  };
}
