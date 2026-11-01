// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import {
  type DatabaseFieldFragment,
  DatabaseFieldKind,
  DatabaseListDensity,
  DatabaseViewKind,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  EmptyState,
  Group,
  MyoxusText,
  Stack,
  SurfaceList,
  SurfaceListAction,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";

import { DatabaseTagBadges, stringArrayCellValue } from "../cells";
import {
  formatCellValue,
  getCellPrimitiveValue,
  getTitleField,
  getVisibleFields,
} from "../model";
import { DatabasePresenceTarget } from "../presence/database-presence-target";
import {
  DatabaseRowActionMenu,
  DatabaseRowStateBadges,
  useDatabaseRowDetail,
  useDeleteDatabaseRowAction,
} from "../row-detail";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRecord, DatabaseRowRecord, DatabaseView } from "../types";
import { databaseViewKindLabel } from "../view-controls/labels";

type DatabaseListPreview =
  | {
      field: DatabaseFieldFragment;
      kind: "tags";
      tagIds: string[];
    }
  | {
      field: DatabaseFieldFragment;
      kind: "value";
      value: string;
    };

export function DatabaseListView({
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
  const regionalPreferences = useRegionalPreferences();
  const rowDetail = useDatabaseRowDetail();
  const deleteRow = useDeleteDatabaseRowAction(databaseId, onChanged);
  const titleField = getTitleField(record);
  const visibleFields = getVisibleFields(record, view).filter(
    (field) => field.id !== titleField.id,
  );

  if (!rows.length) {
    return <EmptyState title={t["com.myoxus.database.row.empty"]()} />;
  }

  const density = view.config.list?.density ?? DatabaseListDensity.Default;
  const itemDensity =
    density === DatabaseListDensity.Compact
      ? "compact"
      : density === DatabaseListDensity.Comfortable
        ? "card"
        : "default";

  return (
    <SurfaceList
      label={databaseViewKindLabel(t, DatabaseViewKind.List)}
      data-testid="database-list-view"
    >
      {rows.map((row) => {
        const previewValues = visibleFields.flatMap<DatabaseListPreview>(
          (field) => {
            if (
              field.fieldType === DatabaseFieldKind.RichText ||
              field.fieldType === DatabaseFieldKind.Title
            ) {
              return [];
            }
            if (field.fieldType === DatabaseFieldKind.Tags) {
              const tagIds = stringArrayCellValue(
                getCellPrimitiveValue(row, field),
              );
              return tagIds.length
                ? [{ field, kind: "tags" as const, tagIds }]
                : [];
            }
            const value = formatCellValue(
              row,
              field,
              t.language,
              {
                checkboxTrue: t["com.myoxus.database.cell.checked"](),
              },
              regionalPreferences,
            );
            return value ? [{ field, kind: "value" as const, value }] : [];
          },
        );
        return (
          <DatabasePresenceTarget
            key={row.row.id}
            rowId={row.row.id}
            viewId={view.id}
          >
            <SurfaceListItem
              alignItems="center"
              density={itemDensity}
              fullWidth
              layout="row"
              data-testid="database-list-row"
            >
              <SurfaceListItemMain grow>
                <SurfaceListAction
                  aria-label={`${row.row.title}: ${t[
                    "com.myoxus.database.row.open-details"
                  ]()}`}
                  onClick={(event) => rowDetail?.open(row, event.currentTarget)}
                >
                  <Stack gap="xs">
                    <SurfaceListText kind="title">
                      {row.row.title}
                    </SurfaceListText>
                    <Group gap="xs" wrap="wrap">
                      {previewValues.map((preview) =>
                        preview.kind === "tags" ? (
                          <Group
                            key={preview.field.id}
                            align="baseline"
                            gap="xs"
                            wrap="wrap"
                          >
                            <MyoxusText
                              tone="secondary"
                              typographySlot="caption"
                            >
                              {preview.field.name}
                            </MyoxusText>
                            <DatabaseTagBadges tagIds={preview.tagIds} />
                          </Group>
                        ) : (
                          <Badge key={preview.field.id} tone="neutral">
                            {preview.field.name}: {preview.value}
                          </Badge>
                        ),
                      )}
                      <DatabaseRowStateBadges row={row} />
                    </Group>
                  </Stack>
                </SurfaceListAction>
              </SurfaceListItemMain>
              <DatabaseRowActionMenu
                record={record}
                onChanged={onChanged}
                canEdit={rowDetail?.canEdit}
                row={row}
                onDelete={() => void deleteRow(row)}
              />
            </SurfaceListItem>
          </DatabasePresenceTarget>
        );
      })}
    </SurfaceList>
  );
}
