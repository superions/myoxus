// SPDX-License-Identifier: AGPL-3.0-or-later

import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import { WorkspaceTagsInlineEditor } from "@myoxus/core/components/tags";
import { DatabaseFieldKind } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Checkbox,
  FormRow,
  Group,
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Modal,
  MultiSelect,
  NumberInput,
  PlaceholderText,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useState } from "react";

import { getSelectOptions } from "../model";
import type { DatabaseField } from "../types";

const BULK_EDITABLE_FIELD_KINDS = new Set<DatabaseFieldKind>([
  DatabaseFieldKind.Checkbox,
  DatabaseFieldKind.Currency,
  DatabaseFieldKind.Date,
  DatabaseFieldKind.DateTime,
  DatabaseFieldKind.Duration,
  DatabaseFieldKind.Email,
  DatabaseFieldKind.MultiSelect,
  DatabaseFieldKind.Number,
  DatabaseFieldKind.Percent,
  DatabaseFieldKind.Phone,
  DatabaseFieldKind.Select,
  DatabaseFieldKind.Status,
  DatabaseFieldKind.Tags,
  DatabaseFieldKind.Text,
  DatabaseFieldKind.Url,
  DatabaseFieldKind.User,
  DatabaseFieldKind.Users,
]);

export function isBulkEditableDatabaseField(field: DatabaseField) {
  return BULK_EDITABLE_FIELD_KINDS.has(field.fieldType);
}

export function databaseBulkTagIntersection(
  values: readonly (readonly string[])[],
) {
  const [first = [], ...rest] = values;
  const remaining = rest.map((value) => new Set(value));
  return Array.from(new Set(first)).filter((id) =>
    remaining.every((value) => value.has(id)),
  );
}

export function DatabaseBulkEditModal({
  fields,
  open,
  pending,
  selectedCount,
  onApply,
  onClear,
  initialValueForField,
  onOpenChange,
}: {
  fields: DatabaseField[];
  open: boolean;
  pending: boolean;
  selectedCount: number;
  onApply: (field: DatabaseField, value: unknown) => Promise<boolean>;
  onClear: (field: DatabaseField) => Promise<boolean>;
  initialValueForField: (field: DatabaseField) => unknown;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useI18n();
  const editableFields = useMemo(
    () => fields.filter(isBulkEditableDatabaseField),
    [fields],
  );
  const editableFieldIds = editableFields.map((field) => field.id).join("\0");
  const firstEditableFieldId = editableFields[0]?.id ?? null;
  const [fieldId, setFieldId] = useState(editableFields[0]?.id ?? null);
  const [value, setValue] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const selectedField =
    editableFields.find((field) => field.id === fieldId) ??
    editableFields[0] ??
    null;

  useEffect(() => {
    if (!open) return;
    setFieldId(firstEditableFieldId);
    setValue(
      editableFields[0] ? initialValueForField(editableFields[0]) : null,
    );
    setDirty(false);
  }, [
    editableFieldIds,
    editableFields,
    firstEditableFieldId,
    initialValueForField,
    open,
  ]);

  const updateValue = (nextValue: unknown) => {
    setValue(nextValue);
    setDirty(true);
  };

  const closeAfter = async (operation: Promise<boolean>) => {
    if (await operation) onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.database.bulk.action.edit"]()}
      data-testid="database-bulk-edit-modal"
    >
      <Stack gap="md">
        <FormRow label={t["com.myoxus.database.csv-import.field"]()}>
          <Select
            block
            data={editableFields.map((field) => ({
              label: field.name,
              value: field.id,
            }))}
            value={selectedField?.id ?? null}
            onChange={(nextFieldId) => {
              setFieldId(nextFieldId);
              const nextField = editableFields.find(
                (field) => field.id === nextFieldId,
              );
              setValue(nextField ? initialValueForField(nextField) : null);
              setDirty(false);
            }}
            data-testid="database-bulk-edit-field"
          />
        </FormRow>

        {selectedField ? (
          <FormRow label={selectedField.name}>
            <DatabaseBulkValueControl
              field={selectedField}
              value={value}
              onChange={updateValue}
            />
          </FormRow>
        ) : null}

        <Group justify="space-between" gap="xs" wrap="wrap">
          <Button
            variant="secondary"
            disabled={!selectedField || pending}
            onClick={() => {
              if (selectedField) void closeAfter(onClear(selectedField));
            }}
            data-testid="database-bulk-clear-field"
          >
            {t["com.myoxus.database.bulk.action.clear"]()}
          </Button>
          <Group justify="end" gap="xs">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {t["Cancel"]()}
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!selectedField || !dirty}
              onClick={() => {
                if (selectedField) {
                  void closeAfter(onApply(selectedField, value));
                }
              }}
              data-testid="database-bulk-apply-field"
            >
              {t["com.myoxus.m.selector.confirm-default"]()} ({selectedCount})
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function DatabaseBulkValueControl({
  field,
  value,
  onChange,
}: {
  field: DatabaseField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const t = useI18n();

  if (
    field.fieldType === DatabaseFieldKind.Select ||
    field.fieldType === DatabaseFieldKind.Status
  ) {
    return (
      <Select
        block
        clearable
        data={getSelectOptions(field).map((option) => ({
          label: option.name,
          value: option.id,
        }))}
        value={typeof value === "string" ? value : null}
        onChange={onChange}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        data-testid="database-bulk-edit-value"
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.MultiSelect) {
    return (
      <MultiSelect
        block
        clearable
        data={getSelectOptions(field).map((option) => ({
          label: option.name,
          value: option.id,
        }))}
        value={Array.isArray(value) ? value.map(String) : []}
        onChange={onChange}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        data-testid="database-bulk-edit-value"
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.User ||
    field.fieldType === DatabaseFieldKind.Users
  ) {
    const selected = Array.isArray(value)
      ? value.map(String)
      : typeof value === "string" && value
        ? [value]
        : [];
    return (
      <MemberSelectorInline
        selected={selected}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        onChange={(next) =>
          onChange(
            field.fieldType === DatabaseFieldKind.User
              ? (next.at(-1) ?? "")
              : next,
          )
        }
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Tags) {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <WorkspaceTagsInlineEditor
        selectedTags={selected}
        tagMode="db-label"
        commit={onChange}
        placeholder={
          <PlaceholderText>
            {t["com.myoxus.database.cell.empty"]()}
          </PlaceholderText>
        }
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Checkbox) {
    return (
      <Checkbox
        checked={Boolean(value)}
        label={field.name}
        onChange={(_, checked) => onChange(checked)}
        data-testid="database-bulk-edit-value"
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Date) {
    return (
      <LocalizedDateInput
        clearable
        locale={t.language}
        value={typeof value === "string" ? value : null}
        onChange={onChange}
        data-testid="database-bulk-edit-value"
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.DateTime) {
    return (
      <LocalizedDateTimeInput
        clearable
        locale={t.language}
        value={typeof value === "string" ? value : null}
        onChange={onChange}
        data-testid="database-bulk-edit-value"
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Number ||
    field.fieldType === DatabaseFieldKind.Percent ||
    field.fieldType === DatabaseFieldKind.Currency ||
    field.fieldType === DatabaseFieldKind.Duration
  ) {
    return (
      <NumberInput
        value={typeof value === "number" ? value : undefined}
        onChange={onChange}
        suffix={
          field.fieldType === DatabaseFieldKind.Percent
            ? "%"
            : field.fieldType === DatabaseFieldKind.Duration
              ? " min"
              : undefined
        }
        data-testid="database-bulk-edit-value"
      />
    );
  }

  return (
    <Input
      block
      value={typeof value === "string" ? value : ""}
      onChange={onChange}
      placeholder={t["com.myoxus.database.cell.empty"]()}
      data-testid="database-bulk-edit-value"
    />
  );
}
