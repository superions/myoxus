// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseFilesPreviewPolicy } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Group,
  ResponsiveGrid,
  Stack,
} from "@myoxus/ui-facade";

import {
  getCellPrimitiveValue,
  getFieldById,
  getTitleField,
  getVisibleFields,
} from "../model";
import {
  DatabaseRowActionMenu,
  DatabaseRowStateBadges,
  DatabaseRowTitle,
  DatabaseViewFieldValues,
  useDatabaseRowDetail,
  useDeleteDatabaseRowAction,
} from "../row-detail";
import {
  databaseCoverFile,
  type DatabaseChangeHandler,
  DatabaseFilePreview,
} from "../shared";
import type { DatabaseRecord, DatabaseRowRecord, DatabaseView } from "../types";

export function DatabaseGalleryView({
  databaseId,
  onChanged,
  record,
  rows,
  view,
}: {
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  view: DatabaseView;
}) {
  const t = useI18n();
  const rowDetail = useDatabaseRowDetail();
  const deleteRow = useDeleteDatabaseRowAction(databaseId, onChanged);
  const titleField = getTitleField(record);
  const visibleFields = getVisibleFields(record, view).filter(
    (field) => field.id !== titleField.id,
  );
  const coverFieldId = view.config.gallery?.coverFieldId;
  const coverField = coverFieldId ? getFieldById(record, coverFieldId) : null;

  if (!rows.length) {
    return <EmptyState title={t["com.myoxus.database.row.empty"]()} />;
  }

  return (
    <ResponsiveGrid
      cols={{ base: 1, md: 2 }}
      data-testid="database-gallery-view"
    >
      {rows.map((row) => (
        <Card
          key={row.row.id}
          padding="none"
          fullHeight
          interactive={Boolean(rowDetail)}
          role={rowDetail ? "button" : undefined}
          tabIndex={rowDetail ? 0 : undefined}
          aria-label={
            rowDetail
              ? `${row.row.title}: ${t[
                  "com.myoxus.database.row.open-details"
                ]()}`
              : undefined
          }
          onClick={(event) => {
            if (!rowDetail) return;
            if (
              (event.target as HTMLElement).closest(
                "button, a, input, textarea, select, [contenteditable='true']",
              )
            ) {
              return;
            }
            rowDetail.open(row, event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (!rowDetail || event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            rowDetail.open(row, event.currentTarget);
          }}
          data-testid="database-gallery-card"
        >
          {(() => {
            if (
              coverField?.config.files?.previewPolicy ===
              DatabaseFilesPreviewPolicy.Disabled
            ) {
              return null;
            }
            const files = coverField
              ? getCellPrimitiveValue(row, coverField)
              : [];
            const cover = databaseCoverFile(Array.isArray(files) ? files : []);
            return cover || (view.config.gallery?.showEmptyCover ?? true) ? (
              <DatabaseFilePreview
                aspectRatio="3 / 1"
                file={cover}
                workspaceId={record.database.workspaceId}
                locale={t.language}
                emptyLabel={t["com.myoxus.database.files.empty-cover"]()}
                errorLabel={t["com.myoxus.common.preview-unavailable"]()}
                retryLabel={t["Retry"]()}
              />
            ) : null;
          })()}
          <CardHeader>
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <CardTitle>
                <DatabaseRowTitle
                  databaseId={databaseId}
                  onChanged={onChanged}
                  record={record}
                  row={row}
                  rows={rows}
                  titleField={titleField}
                  viewId={view.id}
                />
              </CardTitle>
              <DatabaseRowActionMenu
                record={record}
                onChanged={onChanged}
                canEdit={rowDetail?.canEdit}
                row={row}
                onDelete={() => void deleteRow(row)}
              />
            </Group>
            <DatabaseRowStateBadges row={row} />
          </CardHeader>
          <CardContent>
            <Stack gap="sm">
              <DatabaseViewFieldValues
                databaseId={databaseId}
                fields={visibleFields}
                onChanged={onChanged}
                record={record}
                row={row}
                rows={rows}
                showLabels
              />
            </Stack>
          </CardContent>
        </Card>
      ))}
    </ResponsiveGrid>
  );
}
