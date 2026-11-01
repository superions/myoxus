import { useCreateRowFromTemplate } from "../row-templates/use-create-row-from-template";
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  createDatabaseRowMutation,
  DatabaseFieldKind,
  DatabaseProfileKind,
  databaseProgressQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  EmptyState,
  Group,
  Loading,
  Progress,
  SelectableCardRow,
  SimpleGrid,
  Stack,
  StatCell,
  SurfaceList,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";

import {
  getCellPrimitiveValue,
  getFieldById,
  getTitleField,
  getVisibleFields,
} from "../model";
import { defaultDatabaseRowTemplate } from "../row-templates";
import type { DatabaseChangeHandler } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
  DatabaseView,
} from "../types";

export type DatabaseProgressPrimaryAction = {
  disabled?: boolean;
  label: string;
  onSelect: () => void;
};

export interface DatabaseProgressViewProps {
  canEdit: boolean;
  databaseId: string;
  effectiveQueryRevision: string;
  onApplyGroupFilter: (field: DatabaseField, key: string) => Promise<void>;
  onChanged: DatabaseChangeHandler;
  onToolbarActionChange?: (
    action: DatabaseProgressPrimaryAction | null,
  ) => void;
  record: DatabaseRecord;
  renderRowPanel: (
    row: DatabaseRowRecord,
    visibleFields: DatabaseField[],
  ) => ReactNode;
  renderRowState: (row: DatabaseRowRecord) => ReactNode;
  rows: DatabaseRowRecord[];
  rowTemplates?: DatabaseRowTemplateBinding[];
  view: DatabaseView;
  workspaceId: string;
}

function defaultAvailableTaskTemplate(
  rowTemplates: DatabaseRowTemplateBinding[],
) {
  return defaultDatabaseRowTemplate(rowTemplates, "task");
}

function progressGroupLabel(
  t: ReturnType<typeof useI18n>,
  groupField: DatabaseField | undefined,
  key: string,
  fallback: string,
) {
  if (groupField?.fieldType !== DatabaseFieldKind.Status) return fallback;
  switch (key) {
    case "notStarted":
      return t["com.myoxus.database.progress.group.not-started"]();
    case "active":
      return t["com.myoxus.database.progress.group.active"]();
    case "complete":
      return t["com.myoxus.database.progress.group.complete"]();
    case "archived":
      return t["com.myoxus.database.progress.group.archived"]();
    default:
      return fallback;
  }
}

/**
 * Server-backed Project progress presentation. Query semantics remain owned by
 * the shared Database API; this component only projects that contract through
 * Mantine-backed Facade primitives and delegates shared row editors/actions to
 * its host.
 */
export function DatabaseProgressView({
  canEdit,
  databaseId,
  effectiveQueryRevision,
  onApplyGroupFilter,
  onChanged,
  onToolbarActionChange,
  record,
  renderRowPanel,
  renderRowState,
  rows,
  rowTemplates = [],
  view,
  workspaceId,
}: DatabaseProgressViewProps) {
  const t = useI18n();
  const createRow = useMutation({ mutation: createDatabaseRowMutation });
  const createRowFromTemplate = useCreateRowFromTemplate(workspaceId);
  const config = view.config.progress;
  const progressField = config
    ? getFieldById(record, config.progressFieldId)
    : undefined;
  const groupField = config?.groupFieldId
    ? getFieldById(record, config.groupFieldId)
    : undefined;
  const titleField = getTitleField(record);
  const visibleFields = getVisibleFields(record, view).filter(
    (field) => field.id !== titleField.id && field.id !== progressField?.id,
  );
  const visibleRows = useMemo(
    () =>
      record.database.profileKind === DatabaseProfileKind.Project
        ? rows.filter((row) => row.row.rowKind === "task")
        : rows,
    [record.database.profileKind, rows],
  );
  const {
    data,
    error,
    isLoading,
    mutate: refreshProgressSummary,
  } = useQuery(
    config
      ? {
          query: databaseProgressQuery,
          variables: { workspaceId, databaseId, viewId: view.id },
        }
      : undefined,
    { suspense: false, suppressErrorNotification: true },
  );
  const summary = data?.workspace?.databaseProgress;
  const taskTemplate = useMemo(
    () => defaultAvailableTaskTemplate(rowTemplates),
    [rowTemplates],
  );
  const progressQueryRevisionRef = useRef(effectiveQueryRevision);

  useEffect(() => {
    if (progressQueryRevisionRef.current === effectiveQueryRevision) return;
    progressQueryRevisionRef.current = effectiveQueryRevision;
    void refreshProgressSummary();
  }, [effectiveQueryRevision, refreshProgressSummary]);

  const addTask = useCallback(async () => {
    let rowId: string | undefined;
    if (taskTemplate) {
      const response = await createRowFromTemplate.trigger({
        input: {
          databaseId,
          rowTemplateId: taskTemplate.rowTemplate.id,
          title: t["com.myoxus.database.row.new-title"](),
        },
      });
      if (!response) return;
      rowId = response.createDatabaseRowFromTemplate.row.id;
    } else {
      const response = await createRow.trigger({
        input: {
          databaseId,
          title: t["com.myoxus.database.row.new-title"](),
        },
      });
      rowId = response?.createDatabaseRow?.row.id;
    }
    await onChanged({ kind: "row_created", target: { rowId } });
  }, [
    createRow,
    createRowFromTemplate,
    databaseId,
    onChanged,
    t,
    taskTemplate,
  ]);

  useEffect(() => {
    if (!onToolbarActionChange) return;
    onToolbarActionChange({
      disabled: !canEdit,
      label: t["com.myoxus.database.kanban.add-task"](),
      onSelect: () => void addTask(),
    });
  }, [addTask, canEdit, onToolbarActionChange, t]);

  if (!config || !progressField) {
    return (
      <EmptyState
        title={t["com.myoxus.database.selector.error-title"]()}
        description={t["com.myoxus.database.selector.error-description"]()}
      />
    );
  }
  if (isLoading) return <Loading data-testid="database-progress-loading" />;
  if (error || !summary) {
    return (
      <EmptyState
        title={t["com.myoxus.database.selector.error-title"]()}
        description={t["com.myoxus.database.selector.error-description"]()}
      />
    );
  }

  return (
    <Stack gap="md" data-testid="database-progress-view">
      <SimpleGrid
        cols={{ base: 2, sm: 3, lg: 6 }}
        data-testid="database-progress-summary"
      >
        <StatCell
          label={t["com.myoxus.database.progress.total"]()}
          value={summary.totalCount}
        />
        <StatCell
          label={t["com.myoxus.database.progress.blocked"]()}
          value={summary.blockedCount}
        />
        <StatCell
          label={t["com.myoxus.database.progress.overdue"]()}
          value={summary.overdueCount}
        />
        <StatCell
          label={t["com.myoxus.database.progress.completed"]()}
          value={summary.completedCount}
        />
        <StatCell
          label={t["com.myoxus.database.progress.incomplete"]()}
          value={summary.incompleteCount}
        />
        <StatCell
          label={t["com.myoxus.database.progress.average"]()}
          value={`${Math.round(summary.averageProgress ?? 0)}%`}
        />
      </SimpleGrid>

      {summary.groups.length ? (
        <SurfaceList
          label={t["com.myoxus.database.progress.groups"]()}
          data-testid="database-progress-groups"
        >
          {summary.groups.map((group) => {
            const label = progressGroupLabel(
              t,
              groupField,
              group.key,
              group.label,
            );
            const percentage = Math.round(group.averageProgress ?? 0);
            return (
              <SelectableCardRow
                key={group.key}
                appearance="row"
                density="compact"
                disabled={!groupField}
                onClick={() =>
                  groupField
                    ? void onApplyGroupFilter(groupField, group.key)
                    : undefined
                }
                aria-label={`${t["com.myoxus.filter"]()}: ${label}`}
                data-testid="database-progress-group"
              >
                <Stack gap="xs">
                  <Group justify="space-between" wrap="wrap">
                    <SurfaceListText kind="title">{label}</SurfaceListText>
                    <Badge tone="info">{percentage}%</Badge>
                  </Group>
                  <Progress
                    value={group.averageProgress ?? 0}
                    showValueLabel={false}
                    ariaLabel={`${label}: ${percentage}%`}
                  />
                  <Group gap="xs" wrap="wrap">
                    <Badge tone="neutral">
                      {group.totalCount}{" "}
                      {t["com.myoxus.database.progress.tasks"]()}
                    </Badge>
                    <Badge tone="success">
                      {group.completedCount}{" "}
                      {t["com.myoxus.database.progress.completed"]()}
                    </Badge>
                    <Badge tone="neutral">
                      {group.incompleteCount}{" "}
                      {t["com.myoxus.database.progress.incomplete"]()}
                    </Badge>
                    {group.blockedCount > 0 ? (
                      <Badge tone="warning">
                        {group.blockedCount}{" "}
                        {t["com.myoxus.database.progress.blocked"]()}
                      </Badge>
                    ) : null}
                    {group.overdueCount > 0 ? (
                      <Badge tone="error">
                        {group.overdueCount}{" "}
                        {t["com.myoxus.database.progress.overdue"]()}
                      </Badge>
                    ) : null}
                  </Group>
                </Stack>
              </SelectableCardRow>
            );
          })}
        </SurfaceList>
      ) : null}

      {visibleRows.length ? (
        <Accordion
          multiple
          variant="contained"
          data-testid="database-progress-rows"
        >
          {visibleRows.map((row) => {
            const rawProgress = getCellPrimitiveValue(row, progressField);
            const progress = typeof rawProgress === "number" ? rawProgress : 0;
            return (
              <AccordionItem key={row.row.id} value={row.row.id}>
                <AccordionControl
                  aria-label={`${row.row.title}: ${Math.round(progress)}%`}
                >
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Stack gap="xs">
                      <SurfaceListText kind="title">
                        {row.row.title}
                      </SurfaceListText>
                      {renderRowState(row)}
                    </Stack>
                    <Progress
                      value={progress}
                      ariaLabel={`${row.row.title}: ${Math.round(progress)}%`}
                    />
                  </SimpleGrid>
                </AccordionControl>
                <AccordionPanel>
                  {renderRowPanel(row, visibleFields)}
                </AccordionPanel>
              </AccordionItem>
            );
          })}
        </Accordion>
      ) : (
        <EmptyState
          title={t["com.myoxus.database.progress.empty-title"]()}
          description={t["com.myoxus.database.progress.empty-description"]()}
          cta={
            <Button
              prefix={<PlusIcon />}
              disabled={!canEdit}
              loading={createRow.isMutating || createRowFromTemplate.isMutating}
              onClick={() => void addTask()}
              data-testid="database-progress-add-task"
            >
              {t["com.myoxus.database.kanban.add-task"]()}
            </Button>
          }
        />
      )}
    </Stack>
  );
}
