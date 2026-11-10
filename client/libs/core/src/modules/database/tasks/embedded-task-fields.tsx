// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormRow,
  InlineContentTrigger,
  SimpleGrid,
  Stack,
} from "@myoxus/ui-facade";
import { useContext, useEffect, useRef, useState } from "react";
import { DatabaseCellEditor } from "../cells";
import type { DatabaseRichTextCellHandle } from "../cells/rich-text-cell";
import { managedTaskFields } from "../managed";
import { databaseFieldDisplayName } from "../presentation/task-labels";
import { DatabaseViewFieldValues } from "../row-detail";
import { TaskDetailNavigationContext } from "../row-detail/task-navigation";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";

export type EmbeddedTaskFieldProps = {
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  canEdit: boolean;
  onChanged: DatabaseChangeHandler;
};

/** One active native editor shares the existing detail leave guard. Description
 * remains inline, and switching fields cannot discard an unconfirmed draft.
 */
export function EmbeddedTaskFields({
  record,
  row,
  canEdit,
  onChanged,
}: EmbeddedTaskFieldProps) {
  const t = useI18n();
  const fields = managedTaskFields(record);
  const navigation = useContext(TaskDetailNavigationContext);
  const [active, setActive] = useState<string | null>(null);
  const richText = useRef<DatabaseRichTextCellHandle>(null);
  const [richDraft, setRichDraft] = useState({ dirty: false, pending: false });
  const register = navigation?.registerEditor;
  useEffect(() => {
    if (active !== "task.description") return;
    register?.({
      ...richDraft,
      apply: () => richText.current?.saveDraft() ?? Promise.resolve(false),
      discard: () => richText.current?.discardDraft(),
    });
    return () => register?.(null);
  }, [active, richDraft, register]);
  const select = (role: string | null) =>
    navigation?.requestLeave
      ? navigation.requestLeave(() => setActive(role))
      : setActive(role);
  const roles = new Map(record.fieldRoles.map((role) => [role.fieldId, role]));
  const render = (role: string) => {
    const field = fields?.get(role);
    if (!field) return null;
    const label = databaseFieldDisplayName(t, record, row, field);
    const summary = (
      <DatabaseViewFieldValues
        databaseId={record.database.id}
        fields={[field]}
        record={record}
        row={row}
        rows={[row]}
        readonly
        compact
        valuesOnly
        onChanged={onChanged}
        roleByFieldId={roles}
      />
    );
    return (
      <FormRow key={field.id} label={label}>
        {active === role ? (
          <Stack>
            <DatabaseCellEditor
              databaseId={record.database.id}
              field={field}
              record={record}
              row={row}
              rows={[row]}
              readonly={!canEdit}
              semanticRoleKey={role}
              inlineEditTrigger="click"
              inlineRichText
              expanded={role === "task.description"}
              richTextHandleRef={
                role === "task.description" ? richText : undefined
              }
              onRichTextDraftStateChange={
                role === "task.description" ? setRichDraft : undefined
              }
              onEditSessionChange={
                role === "task.description" ? undefined : register
              }
              onChanged={async (reason) => {
                await onChanged(reason);
                setActive(null);
              }}
            />
            <Button variant="secondary" onClick={() => select(null)}>
              {t["com.myoxus.peek-view-controls.close"]()}
            </Button>
          </Stack>
        ) : canEdit ? (
          <InlineContentTrigger aria-label={label} onClick={() => select(role)}>
            {summary}
          </InlineContentTrigger>
        ) : (
          summary
        )}
      </FormRow>
    );
  };
  return (
    <Stack data-testid="embedded-task-fields">
      {render("task.title")}
      <SimpleGrid cols={2}>
        {render("task.status")}
        {render("task.assignees")}
        {render("task.dueDate")}
        {render("task.priority")}
      </SimpleGrid>
      {render("task.description")}
      {render("task.dependencies")}
      {render("task.blockedBy")}
    </Stack>
  );
}
