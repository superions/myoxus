// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import {
  createDatabaseFieldMutation,
  createDatabaseViewMutation,
  DatabaseFieldKind,
  DatabaseViewKind,
  updateDatabaseViewMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormRow,
  Group,
  Input,
  Modal,
  MyoxusText,
  notify,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  createKanbanViewConfigInput,
  createProgressViewConfigInput,
  createViewConfigInputFromEdits,
  defaultStatusFieldConfigInput,
  getFieldById,
  proposeDatabaseViewName,
  sortByPosition,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRecord, DatabaseView } from "../types";
import {
  databaseFieldSupportsProgressGrouping,
  VIEW_SORT_NONE,
} from "./labels";

export const KANBAN_CREATE_GROUP_FIELD = "__myoxus_create_kanban_group_field__";

export type KanbanSetupTarget =
  { kind: "create" } | { kind: "update"; view: DatabaseView };

export function getKanbanGroupField(
  record: DatabaseRecord,
  view: DatabaseView,
) {
  const groupFieldId = view.config.kanban?.groupFieldId;
  if (!groupFieldId) return null;
  const field = getFieldById(record, groupFieldId);
  return field?.fieldType === DatabaseFieldKind.Status ||
    field?.fieldType === DatabaseFieldKind.Select
    ? field
    : null;
}

export function getKanbanGroupFieldOptions(record: DatabaseRecord) {
  return sortByPosition(record.fields)
    .filter(
      (field) =>
        field.fieldType === DatabaseFieldKind.Status ||
        field.fieldType === DatabaseFieldKind.Select,
    )
    .sort((left, right) => {
      if (left.fieldType === right.fieldType)
        return left.position - right.position;
      return left.fieldType === DatabaseFieldKind.Status ? -1 : 1;
    })
    .map((field) => ({
      value: field.id,
      label: field.name,
    }));
}

export function KanbanSetupModal({
  databaseId,
  onActiveViewChange,
  onChanged,
  onClose,
  record,
  returnFocusRef,
  target,
}: {
  databaseId: string;
  onActiveViewChange: (viewId: string | null) => void;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  record: DatabaseRecord;
  returnFocusRef?: RefObject<HTMLElement | null>;
  target: KanbanSetupTarget | null;
}) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const createField = useMutation({
    mutation: createDatabaseFieldMutation,
  });
  const createView = useMutation(
    { mutation: createDatabaseViewMutation },
    { throwOnError: false },
  );
  const updateView = useMutation({
    mutation: updateDatabaseViewMutation,
  });
  const selectFieldOptions = useMemo(
    () => getKanbanGroupFieldOptions(record),
    [record],
  );
  const [groupFieldChoice, setGroupFieldChoice] = useState(
    KANBAN_CREATE_GROUP_FIELD,
  );
  const [newFieldName, setNewFieldName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const targetView = target?.kind === "update" ? target.view : null;
  const creatingGroupField =
    groupFieldChoice === KANBAN_CREATE_GROUP_FIELD ||
    !selectFieldOptions.length;

  useEffect(() => {
    if (!target) return;
    const currentGroupField = targetView
      ? getKanbanGroupField(record, targetView)
      : null;
    setGroupFieldChoice(
      currentGroupField?.id ??
        selectFieldOptions[0]?.value ??
        KANBAN_CREATE_GROUP_FIELD,
    );
    setNewFieldName(t["Status"]());
  }, [record, selectFieldOptions, t, target, targetView]);

  const submit = useCallback(async () => {
    if (!target) return;
    let groupFieldId =
      groupFieldChoice === KANBAN_CREATE_GROUP_FIELD ? null : groupFieldChoice;
    let createdGroupField = false;
    let recordForConfig = record;
    setSubmitting(true);
    try {
      if (!groupFieldId) {
        const name = newFieldName.trim();
        if (!name) {
          notify.error({
            title: t["com.myoxus.database.field.create-name-required"](),
          });
          return;
        }
        const response = await createField.trigger({
          input: {
            databaseId,
            name,
            fieldType: DatabaseFieldKind.Status,
            config: defaultStatusFieldConfigInput(),
          },
        });
        const createdField = response?.createDatabaseField;
        if (!createdField) return;
        groupFieldId = createdField.id;
        createdGroupField = true;
        recordForConfig = {
          ...record,
          fields: [...record.fields, createdField],
        };
      }

      if (target.kind === "create") {
        const response = await createView.trigger({
          input: {
            databaseId,
            name: proposeDatabaseViewName(
              record,
              t["com.myoxus.database.view.kanban"](),
            ),
            viewKind: DatabaseViewKind.Kanban,
            config: createKanbanViewConfigInput(recordForConfig, groupFieldId),
          },
        });
        if (!response) return;
        onClose();
        const viewId = response.createDatabaseView.id;
        onActiveViewChange(viewId);
        await onChanged({
          kind: createdGroupField ? "structure_updated" : "view_created",
          target: { fieldId: groupFieldId, viewId: viewId ?? undefined },
        });
        return;
      }

      const config = createViewConfigInputFromEdits(
        recordForConfig,
        target.view,
        { groupFieldId },
      );
      await executeRevisionMutation(
        conflicts,
        updateView.trigger,
        {
          databaseId,
          viewId: target.view.id,
          name: target.view.name,
          config,
          expectedEditRevision: target.view.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.view.settings"](),
          localValue: config,
          reloadLatest: () => onChanged(),
          afterSuccess: async () => {
            onClose();
            await onChanged({
              kind: createdGroupField ? "structure_updated" : "view_updated",
              target: {
                fieldId: groupFieldId ?? undefined,
                viewId: target.view.id,
              },
            });
          },
        },
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    createField,
    createView,
    conflicts,
    databaseId,
    groupFieldChoice,
    newFieldName,
    onActiveViewChange,
    onChanged,
    onClose,
    record,
    t,
    target,
    updateView,
  ]);

  return (
    <Modal
      open={Boolean(target)}
      returnFocusRef={returnFocusRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      contentOptions={{
        "data-testid": "database-kanban-setup",
      }}
      title={t["com.myoxus.database.kanban.invalid-title"]()}
    >
      <Stack gap="md">
        <MyoxusText tone="secondary">
          {t["com.myoxus.database.kanban.invalid-description"]()}
        </MyoxusText>
        <FormRow label={t["com.myoxus.database.view.group-field"]()}>
          <Select
            data={[
              ...selectFieldOptions,
              {
                value: KANBAN_CREATE_GROUP_FIELD,
                label: t["com.myoxus.database.field.create"](),
              },
            ]}
            value={groupFieldChoice}
            onChange={(value) =>
              setGroupFieldChoice(value ?? KANBAN_CREATE_GROUP_FIELD)
            }
            aria-label={t["com.myoxus.database.view.group-field"]()}
            block
          />
        </FormRow>
        {creatingGroupField ? (
          <FormRow label={t["com.myoxus.database.field.name"]()}>
            <Input
              value={newFieldName}
              onChange={setNewFieldName}
              aria-label={t["com.myoxus.database.field.name"]()}
              autoFocus
            />
          </FormRow>
        ) : null}
        <Group justify="flex-end" gap="xs">
          <Button variant="secondary" onClick={onClose}>
            {t["Cancel"]()}
          </Button>
          <Button
            onClick={() => void submit()}
            loading={
              submitting ||
              createField.isMutating ||
              createView.isMutating ||
              updateView.isMutating
            }
          >
            {target?.kind === "create"
              ? t["com.myoxus.database.view.add-kanban"]()
              : t["Save"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ProgressSetupModal({
  databaseId,
  onActiveViewChange,
  onChanged,
  onClose,
  open,
  record,
  returnFocusRef,
}: {
  databaseId: string;
  onActiveViewChange: (viewId: string | null) => void;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  open: boolean;
  record: DatabaseRecord;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const t = useI18n();
  const createView = useMutation(
    { mutation: createDatabaseViewMutation },
    { throwOnError: false },
  );
  const progressFields = useMemo(
    () =>
      sortByPosition(record.fields)
        .filter((field) => field.fieldType === DatabaseFieldKind.Percent)
        .map((field) => ({ value: field.id, label: field.name })),
    [record.fields],
  );
  const groupFields = useMemo(
    () =>
      sortByPosition(record.fields)
        .filter(databaseFieldSupportsProgressGrouping)
        .map((field) => ({ value: field.id, label: field.name })),
    [record.fields],
  );
  const [progressFieldId, setProgressFieldId] = useState<string | null>(null);
  const [groupFieldId, setGroupFieldId] = useState(VIEW_SORT_NONE);

  useEffect(() => {
    if (!open) return;
    setProgressFieldId(progressFields[0]?.value ?? null);
    setGroupFieldId(VIEW_SORT_NONE);
  }, [open, progressFields]);

  const submit = useCallback(async () => {
    if (!progressFieldId) {
      notify.error({
        title: t["com.myoxus.database.progress.needs-percent"](),
      });
      return;
    }
    const response = await createView.trigger({
      input: {
        databaseId,
        name: proposeDatabaseViewName(
          record,
          t["com.myoxus.common.progress"](),
        ),
        viewKind: DatabaseViewKind.Progress,
        config: createProgressViewConfigInput(
          record,
          progressFieldId,
          groupFieldId === VIEW_SORT_NONE ? null : groupFieldId,
        ),
      },
    });
    if (!response) return;
    onClose();
    const viewId = response.createDatabaseView.id;
    onActiveViewChange(viewId);
    await onChanged({
      kind: "view_created",
      target: { viewId: viewId ?? undefined },
    });
  }, [
    createView,
    databaseId,
    groupFieldId,
    onActiveViewChange,
    onChanged,
    onClose,
    progressFieldId,
    record,
    t,
  ]);

  return (
    <Modal
      open={open}
      returnFocusRef={returnFocusRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={t["com.myoxus.database.view.add-progress"]()}
      contentOptions={{ "data-testid": "database-progress-setup" }}
    >
      <Stack gap="md">
        <FormRow label={t["com.myoxus.database.progress.field"]()}>
          <Select
            aria-label={t["com.myoxus.database.progress.field"]()}
            autoFocus
            block
            data={progressFields}
            disabled={!progressFields.length}
            value={progressFieldId}
            onChange={setProgressFieldId}
          />
        </FormRow>
        <FormRow label={t["com.myoxus.page.display.grouping"]()}>
          <Select
            aria-label={t["com.myoxus.page.display.grouping"]()}
            block
            data={[
              {
                value: VIEW_SORT_NONE,
                label: t["com.myoxus.page.display.grouping.no-grouping"](),
              },
              ...groupFields,
            ]}
            value={groupFieldId}
            onChange={(value) => setGroupFieldId(value ?? VIEW_SORT_NONE)}
          />
        </FormRow>
        <Group justify="flex-end" gap="xs">
          <Button variant="secondary" onClick={onClose}>
            {t["Cancel"]()}
          </Button>
          <Button
            onClick={() => void submit()}
            loading={createView.isMutating}
            disabled={!progressFields.length}
          >
            {t["com.myoxus.database.view.add-progress"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
