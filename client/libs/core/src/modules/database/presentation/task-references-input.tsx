// SPDX-License-Identifier: AGPL-3.0-or-later
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  AssistantValueType,
  type AssistantValueFragmentFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService } from "@myoxus/infra";
import { Button, FormRow, Group, Stack } from "@myoxus/ui-facade";
import { useRef, useState } from "react";
import { TaskRowReference } from "../database-block-adapter/task-row-reference";
import { TaskReferencePicker } from "../tasks/task-reference-picker";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { AssistantInputAdapter } from "./renderer";
import { assistantText, assistantValue } from "./values";

/** Only native identities belong in this input; revisions remain mutation facts. */
export function TaskReferencesInput({
  references,
  disabled,
  title,
  onChange,
}: {
  references: NonNullable<AssistantValueFragmentFragment["taskReferences"]>;
  disabled: boolean;
  title?: string;
  onChange?: (
    references: NonNullable<AssistantValueFragmentFragment["taskReferences"]>,
  ) => void;
}) {
  const owner = useTaskIdentity();
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const t = useI18n();
  const [openingOwner, setOpeningOwner] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Stack>
      {references.map((reference) => (
        <Group key={reference.rowId}>
          <TaskRowReference
            framework={framework}
            target={{
              workspaceId: owner.workspace.id,
              databaseId: reference.databaseId,
              rowId: reference.rowId,
            }}
            onOpen={(target) =>
              workbench.open(
                `/tasks?${new URLSearchParams({ databaseId: target.databaseId, rowId: target.rowId })}`,
                { at: "tail" },
              )
            }
          />
          {!disabled && onChange ? (
            <Button
              disabled={disabled}
              onClick={() =>
                onChange(
                  references.filter((item) => item.rowId !== reference.rowId),
                )
              }
            >
              {t["com.myoxus.database.task-references.remove"]()}
            </Button>
          ) : null}
        </Group>
      ))}
      {!disabled && onChange && title ? (
        <Button
          ref={trigger}
          disabled={
            !owner.identity || owner.availability.status !== "available"
          }
          onClick={() => setOpeningOwner(owner.identity ?? undefined)}
        >
          {t.Select()}
        </Button>
      ) : null}
      {openingOwner && !disabled && onChange && title ? (
        <TaskReferencePicker
          mode="select"
          title={title}
          openingOwnerIdentity={openingOwner}
          returnFocusRef={trigger}
          close={() => setOpeningOwner(undefined)}
          onSelectTask={(target) => {
            if (target.workspaceId !== owner.workspace.id) return;
            const selected = {
              databaseId: target.databaseId,
              rowId: target.rowId,
            };
            // A moved Task updates its identity instead of becoming a second prerequisite.
            onChange(
              references.some((item) => item.rowId === target.rowId)
                ? references.map((item) =>
                    item.rowId === target.rowId ? selected : item,
                  )
                : [...references, selected],
            );
          }}
        />
      ) : null}
    </Stack>
  );
}
export function AssistantTaskReferencesInput({
  input,
  value,
  disabled,
  onChange,
  error,
}: AssistantInputAdapter) {
  const t = useI18n();
  const title = assistantText(input.label, t.language);
  return (
    <FormRow
      data-assistant-input={input.id}
      tabIndex={-1}
      label={title}
      help={
        input.description
          ? assistantText(input.description, t.language)
          : undefined
      }
      error={error}
    >
      <TaskReferencesInput
        title={title}
        references={value?.taskReferences ?? []}
        disabled={disabled}
        onChange={(references) =>
          onChange(
            assistantValue(AssistantValueType.TaskReferences, {
              taskReferences: references,
            }),
          )
        }
      />
    </FormRow>
  );
}
