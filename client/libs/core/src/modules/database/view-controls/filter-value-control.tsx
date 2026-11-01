// SPDX-License-Identifier: AGPL-3.0-or-later

import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import { WorkspaceTagsInlineEditor } from "@myoxus/core/components/tags";
import {
  DatabaseFieldKind,
  DatabaseFilterOperator,
  type DatabaseFilterRuleInput,
  type DatabaseFilterValueInput,
  DatabaseRelativeDatePreset,
  DatabaseStatusGroup,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";

import { getSelectOptions } from "../model";
import type { DatabaseField, DatabaseRowRecord } from "../types";
import {
  databaseFilterOperatorNeedsValue,
  databaseRelativeDatePresetLabel,
  databaseStatusGroupOptionLabel,
} from "./labels";

export function DatabaseFilterValueControl({
  field,
  onChange,
  rule,
}: {
  field: DatabaseField;
  onChange: (value: DatabaseFilterValueInput) => void;
  rule: DatabaseFilterRuleInput;
  tagOptions: { label: string; value: string }[];
}) {
  const t = useI18n();
  if (!databaseFilterOperatorNeedsValue(rule.operator)) return null;

  if (rule.operator === DatabaseFilterOperator.Relative) {
    return (
      <Select
        aria-label={field.name}
        data={Object.values(DatabaseRelativeDatePreset).map((value) => ({
          label: databaseRelativeDatePresetLabel(t, value),
          value,
        }))}
        value={rule.value.relativeDate ?? DatabaseRelativeDatePreset.Today}
        onChange={(value) =>
          value &&
          onChange({ relativeDate: value as DatabaseRelativeDatePreset })
        }
      />
    );
  }

  if (rule.operator === DatabaseFilterOperator.Between) {
    if (field.fieldType === DatabaseFieldKind.Date) {
      return (
        <Stack gap="xs">
          <LocalizedDateInput
            aria-label={`${field.name}: ${t["com.myoxus.database.filter.range-start"]()}`}
            locale={t.language}
            value={rule.value.dateRange?.start ?? null}
            onChange={(start) =>
              onChange({ dateRange: { ...rule.value.dateRange, start } })
            }
          />
          <LocalizedDateInput
            aria-label={`${field.name}: ${t["com.myoxus.database.filter.range-end"]()}`}
            locale={t.language}
            value={rule.value.dateRange?.end ?? null}
            onChange={(end) =>
              onChange({ dateRange: { ...rule.value.dateRange, end } })
            }
          />
        </Stack>
      );
    }
    if (
      [
        DatabaseFieldKind.DateTime,
        DatabaseFieldKind.CreatedTime,
        DatabaseFieldKind.UpdatedTime,
      ].includes(field.fieldType)
    ) {
      return (
        <Stack gap="xs">
          <LocalizedDateTimeInput
            aria-label={`${field.name}: ${t["com.myoxus.database.filter.range-start"]()}`}
            locale={t.language}
            value={rule.value.instantRange?.start ?? null}
            onChange={(start) =>
              onChange({
                instantRange: {
                  ...rule.value.instantRange,
                  start: typeof start === "string" ? start : null,
                },
              })
            }
          />
          <LocalizedDateTimeInput
            aria-label={`${field.name}: ${t["com.myoxus.database.filter.range-end"]()}`}
            locale={t.language}
            value={rule.value.instantRange?.end ?? null}
            onChange={(end) =>
              onChange({
                instantRange: {
                  ...rule.value.instantRange,
                  end: typeof end === "string" ? end : null,
                },
              })
            }
          />
        </Stack>
      );
    }
    const start =
      field.fieldType === DatabaseFieldKind.Duration
        ? rule.value.durationRange?.startMinutes
        : field.fieldType === DatabaseFieldKind.Currency
          ? rule.value.currencyRange?.start
          : rule.value.numberRange?.start;
    const end =
      field.fieldType === DatabaseFieldKind.Duration
        ? rule.value.durationRange?.endMinutes
        : field.fieldType === DatabaseFieldKind.Currency
          ? rule.value.currencyRange?.end
          : rule.value.numberRange?.end;
    const updateRange = (
      nextStart: number | null | undefined,
      nextEnd: number | null | undefined,
    ) => {
      if (field.fieldType === DatabaseFieldKind.Currency) {
        onChange({
          currencyRange: {
            currencyCode:
              rule.value.currencyRange?.currencyCode ||
              field.config.currency?.defaultCurrency ||
              "EUR",
            start: nextStart,
            end: nextEnd,
          },
        });
      } else if (field.fieldType === DatabaseFieldKind.Duration) {
        onChange({
          durationRange: { startMinutes: nextStart, endMinutes: nextEnd },
        });
      } else {
        onChange({ numberRange: { start: nextStart, end: nextEnd } });
      }
    };
    return (
      <Stack gap="xs">
        <NumberInput
          aria-label={`${field.name}: ${t["com.myoxus.database.filter.range-start"]()}`}
          value={start ?? undefined}
          onChange={(value) =>
            updateRange(value == null ? null : Number(value), end)
          }
        />
        <NumberInput
          aria-label={`${field.name}: ${t["com.myoxus.database.filter.range-end"]()}`}
          value={end ?? undefined}
          onChange={(value) =>
            updateRange(start, value == null ? null : Number(value))
          }
        />
      </Stack>
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Date ||
    field.fieldType === DatabaseFieldKind.DateTime ||
    field.fieldType === DatabaseFieldKind.CreatedTime ||
    field.fieldType === DatabaseFieldKind.UpdatedTime
  ) {
    if (field.fieldType !== DatabaseFieldKind.Date) {
      return (
        <LocalizedDateTimeInput
          aria-label={field.name}
          clearable
          locale={t.language}
          value={rule.value.instant ?? null}
          onChange={(value) =>
            onChange({ instant: typeof value === "string" ? value : "" })
          }
        />
      );
    }
    return (
      <LocalizedDateInput
        aria-label={field.name}
        clearable
        locale={t.language}
        value={rule.value.date ?? null}
        onChange={(value) => onChange({ date: value ?? "" })}
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Number ||
    field.fieldType === DatabaseFieldKind.Percent ||
    field.fieldType === DatabaseFieldKind.Duration ||
    field.fieldType === DatabaseFieldKind.Currency
  ) {
    const currentValue =
      field.fieldType === DatabaseFieldKind.Currency
        ? (rule.value.currency?.amount ?? 0)
        : field.fieldType === DatabaseFieldKind.Duration
          ? (rule.value.duration?.minutes ?? 0)
          : (rule.value.number ?? 0);
    return (
      <NumberInput
        aria-label={field.name}
        value={currentValue}
        onChange={(value) =>
          onChange(
            field.fieldType === DatabaseFieldKind.Currency
              ? {
                  currency: {
                    amount: Number(value),
                    currencyCode:
                      field.config.currency?.defaultCurrency || "EUR",
                  },
                }
              : field.fieldType === DatabaseFieldKind.Duration
                ? { duration: { minutes: Number(value) } }
                : { number: Number(value) },
          )
        }
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Tags) {
    const multiple = [
      DatabaseFilterOperator.ContainsAll,
      DatabaseFilterOperator.AnyOf,
      DatabaseFilterOperator.NoneOf,
      DatabaseFilterOperator.GroupAnyOf,
      DatabaseFilterOperator.GroupNoneOf,
    ].includes(rule.operator);
    const selected = multiple
      ? (rule.value.ids ?? [])
      : rule.value.optionId
        ? [rule.value.optionId]
        : [];
    return (
      <WorkspaceTagsInlineEditor
        selectedTags={selected}
        tagMode="db-label"
        commit={(ids) =>
          onChange(multiple ? { ids } : { optionId: ids.at(-1) ?? "" })
        }
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Select ||
    field.fieldType === DatabaseFieldKind.Status ||
    field.fieldType === DatabaseFieldKind.MultiSelect
  ) {
    const options = getSelectOptions(field).map((option) => ({
      label: option.name,
      value: option.id,
    }));
    const statusGroup = [
      DatabaseFilterOperator.GroupIs,
      DatabaseFilterOperator.GroupIsNot,
      DatabaseFilterOperator.GroupAnyOf,
      DatabaseFilterOperator.GroupNoneOf,
    ].includes(rule.operator);
    const selectOptions = statusGroup
      ? Object.values(DatabaseStatusGroup).map((value) => ({
          value,
          label: databaseStatusGroupOptionLabel(t, value),
        }))
      : options;
    const multiple = [
      DatabaseFilterOperator.ContainsAll,
      DatabaseFilterOperator.AnyOf,
      DatabaseFilterOperator.NoneOf,
      DatabaseFilterOperator.GroupAnyOf,
      DatabaseFilterOperator.GroupNoneOf,
    ].includes(rule.operator);
    return multiple ? (
      <MultiSelect
        aria-label={field.name}
        data={selectOptions}
        value={rule.value.ids ?? []}
        onChange={(ids) => onChange({ ids })}
      />
    ) : (
      <Select
        aria-label={field.name}
        data={selectOptions}
        value={rule.value.optionId ?? null}
        onChange={(optionId) => onChange({ optionId: optionId ?? "" })}
      />
    );
  }

  if (
    [DatabaseFieldKind.User, DatabaseFieldKind.Users].includes(field.fieldType)
  ) {
    return (
      <MemberSelectorInline
        selected={rule.value.userId ? [rule.value.userId] : []}
        onChange={(selected) => onChange({ userId: selected.at(-1) ?? "" })}
        placeholder={t["com.myoxus.database.filter.select-user"]()}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Relation) {
    return (
      <Input
        aria-label={field.name}
        block
        placeholder={t["com.myoxus.database.filter.value-placeholder"]()}
        value={rule.value.relationRowId ?? ""}
        onChange={(relationRowId) => onChange({ relationRowId })}
      />
    );
  }

  return (
    <Input
      aria-label={field.name}
      block
      placeholder={t["com.myoxus.database.filter.value-placeholder"]()}
      value={rule.value.text ?? ""}
      onChange={(text) => onChange({ text })}
    />
  );
}

export function databaseFilterValueLabel(
  field: DatabaseField,
  rule: DatabaseFilterRuleInput,
  tags: { id: string; name: string }[],
  rows: DatabaseRowRecord[],
) {
  if (!databaseFilterOperatorNeedsValue(rule.operator)) return "";
  const value = rule.value;
  const values =
    value.ids ??
    value.userIds ??
    value.relationRowIds ??
    (value.optionId
      ? [value.optionId]
      : value.userId
        ? [value.userId]
        : value.relationRowId
          ? [value.relationRowId]
          : []);
  if (value.text != null) return value.text;
  if (value.number != null) return String(value.number);
  if (value.date != null) return value.date;
  if (value.instant != null)
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value.instant));
  if (value.relativeDate != null) return String(value.relativeDate);
  if (value.currency != null)
    return `${value.currency.amount} ${value.currency.currencyCode}`;
  if (value.duration != null) return String(value.duration.minutes);
  return values
    .map((value) => {
      if (typeof value === "string") {
        if (field.fieldType === DatabaseFieldKind.Tags) {
          return tags.find((tag) => tag.id === value)?.name ?? value;
        }
        if (field.fieldType === DatabaseFieldKind.Relation) {
          return (
            rows.find((row) => row.row.id === value)?.row.title ??
            rows
              .flatMap((row) => row.cells)
              .flatMap((cell) => cell.value.relationTargets ?? [])
              .find(
                (target) =>
                  target.rowId === value && !target.deleted && !target.redacted,
              )?.title ??
            value
          );
        }
        if (
          field.fieldType === DatabaseFieldKind.Select ||
          field.fieldType === DatabaseFieldKind.Status ||
          field.fieldType === DatabaseFieldKind.MultiSelect
        ) {
          return (
            getSelectOptions(field).find((option) => option.id === value)
              ?.name ?? value
          );
        }
        return value;
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}
