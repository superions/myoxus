// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLiveData, useService } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import { DatabaseFieldKind, DatabaseFilesPreviewPolicy } from "@myoxus/graphql";
import {
  type KanbanCardModel,
  MyoxusText,
  Progress,
  Stack,
} from "@myoxus/ui-facade";

import { TagService } from "@myoxus/core/modules/tag/service/tag";
import {
  DatabaseCellEditor,
  databaseKanbanTagAccentRoles,
  stringArrayCellValue,
} from "../cells";
import { getCellPrimitiveValue } from "../model";
import { DatabasePresenceTarget } from "../presence/database-presence-target";
import {
  DatabaseRowActionMenu,
  DatabaseRowStateBadges,
  DatabaseRowTitle,
  useDatabaseRowDetail,
  useDeleteDatabaseRowAction,
} from "../row-detail";
import { resolveDatabaseRowFieldLayout } from "../row-detail/field-role-resolver";
import {
  databaseCoverFile,
  DatabaseFilePreview,
  type DatabaseChangeHandler,
} from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";
import { DatabaseKanbanProperty } from "./property";

/** Native editors and data stay in this adapter; the frame owns interaction. */
export function useDatabaseKanbanCardContent({
  databaseId,
  onChanged,
  record,
  rows,
  visibleFields,
  viewId,
  coverField,
  workspaceId,
}: {
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  visibleFields: DatabaseField[];
  viewId: string;
  coverField?: DatabaseField | null;
  workspaceId: string;
}): (
  row: DatabaseRowRecord,
) => Pick<
  KanbanCardModel,
  "title" | "cover" | "content" | "actions" | "frame" | "accentRoles"
> {
  const t = useI18n();
  const detail = useDatabaseRowDetail();
  const tagService = useService(TagService);
  const workspaceTags = useLiveData(tagService.tagList.tagMetas$);
  const deleteRow = useDeleteDatabaseRowAction(databaseId, onChanged);
  return (row) => {
    const fieldLayout = resolveDatabaseRowFieldLayout(record, row);
    const visibleFieldIds = new Set(visibleFields.map((field) => field.id));
    const descriptionField =
      fieldLayout.descriptionField &&
      visibleFieldIds.has(fieldLayout.descriptionField.id)
        ? fieldLayout.descriptionField
        : null;
    const progressField = record.fields.find(
      (field) =>
        visibleFieldIds.has(field.id) &&
        fieldLayout.roleByFieldId.get(field.id)?.roleKey ===
          `${row.row.rowKind}.progress`,
    );
    const summaryFields = visibleFields.filter(
      (field) =>
        field.id !== descriptionField?.id && field.id !== progressField?.id,
    );
    const coverValue = coverField
      ? getCellPrimitiveValue(row, coverField)
      : null;
    return {
      accentRoles: databaseKanbanTagAccentRoles(
        visibleFields
          .filter((field) => field.fieldType === DatabaseFieldKind.Tags)
          .flatMap((field) =>
            stringArrayCellValue(getCellPrimitiveValue(row, field)),
          ),
        workspaceTags,
      ),
      frame: (card, { dragging }) => (
        <DatabasePresenceTarget
          dragging={dragging}
          rowId={row.row.id}
          viewId={viewId}
        >
          {card}
        </DatabasePresenceTarget>
      ),
      cover:
        coverField &&
        coverField.config.files?.previewPolicy !==
          DatabaseFilesPreviewPolicy.Disabled ? (
          <DatabaseFilePreview
            file={databaseCoverFile(
              Array.isArray(coverValue) ? coverValue : [],
            )}
            workspaceId={workspaceId}
            locale={t.language}
            emptyLabel={t["com.myoxus.database.files.empty-cover"]()}
            errorLabel={t["com.myoxus.common.preview-unavailable"]()}
            retryLabel={t["Retry"]()}
          />
        ) : null,
      title: ({ setInteractionDisabled }) =>
        detail?.canEdit ? (
          <DatabaseRowTitle
            databaseId={databaseId}
            onChanged={onChanged}
            onInlineEditChange={setInteractionDisabled}
            record={record}
            row={row}
            rows={rows}
            titleField={fieldLayout.titleField}
            viewId={viewId}
            displayLineClamp={2}
            withPresence={false}
          />
        ) : (
          <MyoxusText
            component="span"
            data-myoxus-ui-role="inline-edit-display"
          >
            {row.row.title}
          </MyoxusText>
        ),
      content: ({ setInteractionDisabled }) => (
        <>
          {row.row.deletedAt || row.redacted ? (
            <DatabaseRowStateBadges row={row} />
          ) : null}
          {!row.redacted && descriptionField ? (
            <Stack gap="xs">
              <MyoxusText tone="secondary" typographySlot="caption">
                {descriptionField.name}
              </MyoxusText>
              <DatabaseCellEditor
                databaseId={databaseId}
                field={descriptionField}
                inlineRichText
                onChanged={onChanged}
                onInlineEditChange={setInteractionDisabled}
                readonly={!detail?.canEdit}
                record={record}
                row={row}
                rows={rows}
                semanticRoleKey={
                  fieldLayout.roleByFieldId.get(descriptionField.id)?.roleKey
                }
              />
            </Stack>
          ) : null}
          {row.redacted ? (
            <MyoxusText tone="secondary">
              {t["com.myoxus.database.row.redacted"]()}
            </MyoxusText>
          ) : (
            <Stack gap="xs">
              {summaryFields.map((field) => (
                <DatabaseKanbanProperty
                  key={field.id}
                  field={field}
                  row={row}
                />
              ))}
              {progressField ? (
                <Progress
                  ariaLabel={progressField.name}
                  showValueLabel
                  value={
                    typeof getCellPrimitiveValue(row, progressField) ===
                    "number"
                      ? (getCellPrimitiveValue(row, progressField) as number)
                      : 0
                  }
                  testId="database-kanban-task-progress"
                />
              ) : null}
            </Stack>
          )}
        </>
      ),
      actions: (
        <DatabaseRowActionMenu
          record={record}
          onChanged={onChanged}
          canEdit={detail?.canEdit}
          row={row}
          onDelete={() => void deleteRow(row)}
        />
      ),
    };
  };
}
