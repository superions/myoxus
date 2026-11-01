// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AssistantInputTarget,
  type AssistantPackageFragmentFragment,
  type AssistanceMode,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Input, Stack } from "@myoxus/ui-facade";
import type { ReactNode } from "react";
import {
  assistantText,
  type AssistantAnswers,
} from "@myoxus/core/modules/database/presentation/values";
import { useAssistantFormValidation } from "@myoxus/core/modules/database/presentation/use-form-validation";
import { workspaceInitialAnswers } from "./model";

/** Bind Empty and the confirmed personal mode internally; the only authored
 * field is the workspace name. Native preparation still validates all answers. */
export function WorkspaceCloudForm({
  descriptor,
  mode,
  name,
  onNameChange,
  disabled,
  target,
  children,
  onSubmit,
  nameError,
}: {
  descriptor: AssistantPackageFragmentFragment;
  mode: AssistanceMode;
  name: string;
  onNameChange: (value: string) => void;
  disabled: boolean;
  target: ReactNode;
  nameError?: string;
  children: (
    answers: AssistantAnswers,
    validate: () => boolean,
    form: ReactNode,
  ) => ReactNode;
  onSubmit: (answers: AssistantAnswers) => void;
}) {
  const t = useI18n();
  const answers = workspaceInitialAnswers(descriptor, name, mode);
  const validation = useAssistantFormValidation(descriptor, answers);
  const input = descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.WorkspaceName,
  );
  const form = (
    <form
      ref={validation.formRef}
      id="create-workspace-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.validate()) onSubmit(answers);
      }}
    >
      <Stack>
        <Input
          autoFocus
          data-autofocus
          data-testid="create-workspace-input"
          data-assistant-input={input?.id}
          label={
            input
              ? assistantText(input.label, t.language)
              : t["com.myoxus.nameWorkspace.subtitle.workspace-name"]()
          }
          required
          disabled={disabled}
          maxLength={64}
          value={name}
          error={
            nameError ||
            (input && validation.invalidInputs.has(input.id)
              ? t["com.myoxus.document-metadata.validation.required"]({
                  label: assistantText(input.label, t.language),
                })
              : undefined)
          }
          onChange={onNameChange}
        />
        {target}
      </Stack>
    </form>
  );
  return children(answers, validation.validate, form);
}
