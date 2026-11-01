// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { InlineMemberList } from "@myoxus/core/components/member-selector/inline-member-list";
import { DatabaseFieldKind } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Badge, Group, MyoxusText } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

import {
  cellActionHref,
  DatabaseTagBadges,
  stringArrayCellValue,
} from "../cells";
import {
  formatCellValue,
  getCellPrimitiveValue,
  getSelectOptions,
} from "../model";
import type { DatabaseField, DatabaseRowRecord } from "../types";

export function DatabaseKanbanProperty({
  field,
  row,
}: {
  field: DatabaseField;
  row: DatabaseRowRecord;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const primitiveValue = getCellPrimitiveValue(row, field);
  const formattedValue = formatCellValue(
    row,
    field,
    t.language,
    {
      checkboxTrue: t["com.myoxus.database.cell.checked"](),
    },
    regionalPreferences,
  );
  if (!formattedValue) return null;
  let value: ReactNode = null;
  if (
    field.fieldType === DatabaseFieldKind.Select ||
    field.fieldType === DatabaseFieldKind.Status
  ) {
    const option = getSelectOptions(field).find(
      (candidate) => candidate.id === String(primitiveValue ?? ""),
    );
    const label = option?.name ?? formattedValue;
    value = label ? <Badge tone="neutral">{label}</Badge> : null;
  } else if (field.fieldType === DatabaseFieldKind.MultiSelect) {
    const selectedOptionIds = Array.isArray(primitiveValue)
      ? primitiveValue.map((optionId) => String(optionId))
      : [];
    const optionsById = new Map(
      getSelectOptions(field).map((option) => [option.id, option.name]),
    );
    const labels = selectedOptionIds
      .map((optionId) => optionsById.get(optionId) ?? optionId)
      .filter(Boolean);
    value = labels.length ? (
      <Group gap="xs" wrap="wrap">
        {labels.map((label) => (
          <Badge key={label} tone="neutral">
            {label}
          </Badge>
        ))}
      </Group>
    ) : null;
  } else if (
    field.fieldType === DatabaseFieldKind.User ||
    field.fieldType === DatabaseFieldKind.Users
  ) {
    value = (
      <InlineMemberList
        members={
          field.fieldType === DatabaseFieldKind.User
            ? typeof primitiveValue === "string" && primitiveValue
              ? [primitiveValue]
              : []
            : stringArrayCellValue(primitiveValue)
        }
      />
    );
  } else if (field.fieldType === DatabaseFieldKind.Tags) {
    value = <DatabaseTagBadges tagIds={stringArrayCellValue(primitiveValue)} />;
  } else {
    const actionHref = cellActionHref(field, formattedValue);
    value = actionHref ? (
      <MyoxusText
        component="a"
        href={actionHref}
        rel={
          field.fieldType === DatabaseFieldKind.Url
            ? "noopener noreferrer"
            : undefined
        }
        target={
          field.fieldType === DatabaseFieldKind.Url ? "_blank" : undefined
        }
        tone="link"
        typographySlot="body-small"
      >
        {formattedValue}
      </MyoxusText>
    ) : (
      <MyoxusText tone="primary" typographySlot="body-small">
        {formattedValue}
      </MyoxusText>
    );
  }
  if (!value) return null;
  // Kanban cards are scannable summaries; table cells keep the heavier editors.
  return (
    <Group
      gap="xs"
      align="baseline"
      wrap="wrap"
      data-testid="database-kanban-property"
    >
      <MyoxusText tone="secondary" typographySlot="caption">
        {field.name}
      </MyoxusText>
      {value}
    </Group>
  );
}
