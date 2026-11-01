// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseCalendarDateMode,
  DatabaseCardDensity,
  DatabaseFieldKind,
  DatabaseFilterConjunction,
  type DatabaseFilterGroupInput,
  DatabaseFilterOperator,
  type DatabaseFilterRuleInput,
  type DatabaseFilterValueInput,
  DatabaseGalleryCardDensity,
  DatabaseListDensity,
  DatabaseRelativeDatePreset,
  DatabaseStatusGroup,
  DatabaseTimelineGroupBy,
  DatabaseTimelineZoom,
  DatabaseViewKind,
  DatabaseViewSystemIcon,
} from "@myoxus/graphql";
import {
  AllDocsGridViewIcon,
  CalendarDaysIcon,
  DatabaseKanbanViewIcon,
  DatabaseListViewIcon,
  DatabaseTableViewIcon,
  ProgressIcon as DatabaseProgressViewIcon,
  TimelineIcon,
} from "@myoxus/icons/react";
import { MyoxusText } from "@myoxus/ui-facade";

import type { I18nShape } from "../field-settings";
import type { DatabaseField, DatabaseView } from "../types";
import type { DatabaseViewControlSection } from "./filter-tree";
import { createDatabaseFilterGroup } from "./filter-tree";

export const VIEW_SORT_NONE = "__myoxus_no_database_sort__";

export function databaseViewKindLabel(t: I18nShape, kind: DatabaseViewKind) {
  switch (kind) {
    case DatabaseViewKind.Calendar:
      return t["com.myoxus.database.view.calendar"]();
    case DatabaseViewKind.Gallery:
      return t["com.myoxus.database.view.gallery"]();
    case DatabaseViewKind.Gantt:
      return t["com.myoxus.database.view.gantt"]();
    case DatabaseViewKind.Kanban:
      return t["com.myoxus.database.view.kanban"]();
    case DatabaseViewKind.List:
      return t["com.myoxus.database.view.list"]();
    case DatabaseViewKind.Progress:
      return t["com.myoxus.common.progress"]();
    case DatabaseViewKind.Timeline:
      return t["com.myoxus.database.view.timeline"]();
    case DatabaseViewKind.Table:
    default:
      return t["com.myoxus.database.view.table"]();
  }
}

export function DatabaseViewIcon({
  icon,
  kind,
}: {
  icon?: DatabaseView["icon"];
  kind: DatabaseViewKind;
}) {
  if (icon?.emoji) {
    return <MyoxusText component="span">{icon.emoji}</MyoxusText>;
  }
  const resolvedKind = (() => {
    switch (icon?.system) {
      case DatabaseViewSystemIcon.Board:
        return DatabaseViewKind.Kanban;
      case DatabaseViewSystemIcon.Calendar:
        return DatabaseViewKind.Calendar;
      case DatabaseViewSystemIcon.Gallery:
        return DatabaseViewKind.Gallery;
      case DatabaseViewSystemIcon.List:
        return DatabaseViewKind.List;
      case DatabaseViewSystemIcon.Progress:
        return DatabaseViewKind.Progress;
      case DatabaseViewSystemIcon.Timeline:
        return DatabaseViewKind.Timeline;
      case DatabaseViewSystemIcon.Table:
        return DatabaseViewKind.Table;
      default:
        return kind;
    }
  })();
  switch (resolvedKind) {
    case DatabaseViewKind.Calendar:
      return <CalendarDaysIcon />;
    case DatabaseViewKind.Gallery:
      return <AllDocsGridViewIcon />;
    case DatabaseViewKind.Gantt:
      return <TimelineIcon />;
    case DatabaseViewKind.Kanban:
      return <DatabaseKanbanViewIcon />;
    case DatabaseViewKind.List:
      return <DatabaseListViewIcon />;
    case DatabaseViewKind.Progress:
      return <DatabaseProgressViewIcon />;
    case DatabaseViewKind.Timeline:
      return <TimelineIcon />;
    case DatabaseViewKind.Table:
    default:
      return <DatabaseTableViewIcon />;
  }
}

/**
 * Let Mantine finish closing a menu and restore its trigger before mounting a
 * dialog. The dialog can then return focus to a durable control instead of the
 * menu item that is removed from the DOM during the same interaction.
 */
export function openDatabaseDialogAfterMenuClose(open: () => void) {
  requestAnimationFrame(open);
}

export function databaseFilterOperators(t: I18nShape, field: DatabaseField) {
  const empty = [
    {
      value: DatabaseFilterOperator.Empty,
      label: t["com.myoxus.filter.is empty"](),
    },
    {
      value: DatabaseFilterOperator.NotEmpty,
      label: t["com.myoxus.filter.is not empty"](),
    },
  ];
  switch (field.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return [
        {
          value: DatabaseFilterOperator.Checked,
          label: t["com.myoxus.filter.true"](),
        },
        {
          value: DatabaseFilterOperator.Unchecked,
          label: t["com.myoxus.filter.false"](),
        },
      ];
    case DatabaseFieldKind.Date:
    case DatabaseFieldKind.DateTime:
    case DatabaseFieldKind.CreatedTime:
    case DatabaseFieldKind.UpdatedTime:
      return [
        {
          value: DatabaseFilterOperator.On,
          label: t["com.myoxus.filter.is"](),
        },
        {
          value: DatabaseFilterOperator.Before,
          label: t["com.myoxus.filter.before"](),
        },
        {
          value: DatabaseFilterOperator.After,
          label: t["com.myoxus.filter.after"](),
        },
        {
          value: DatabaseFilterOperator.Between,
          label: t["com.myoxus.filter.between"](),
        },
        {
          value: DatabaseFilterOperator.Relative,
          label: t["com.myoxus.filter.relative"](),
        },
        ...empty,
      ];
    case DatabaseFieldKind.MultiSelect:
    case DatabaseFieldKind.Tags:
      return [
        {
          value: DatabaseFilterOperator.Contains,
          label: t["com.myoxus.filter.contains one of"](),
        },
        {
          value: DatabaseFilterOperator.ContainsAll,
          label: t["com.myoxus.filter.contains all"](),
        },
        {
          value: DatabaseFilterOperator.DoesNotContain,
          label: t["com.myoxus.filter.does-not-contain"](),
        },
        ...empty,
      ];
    case DatabaseFieldKind.Number:
    case DatabaseFieldKind.Percent:
    case DatabaseFieldKind.Currency:
    case DatabaseFieldKind.Duration:
      return [
        {
          value: DatabaseFilterOperator.Equals,
          label: t["com.myoxus.filter.is"](),
        },
        {
          value: DatabaseFilterOperator.NotEquals,
          label: t["com.myoxus.filter.is-not"](),
        },
        {
          value: DatabaseFilterOperator.Greater,
          label: t["com.myoxus.filter.greater"](),
        },
        {
          value: DatabaseFilterOperator.GreaterOrEqual,
          label: t["com.myoxus.filter.greater-or-equal"](),
        },
        {
          value: DatabaseFilterOperator.Less,
          label: t["com.myoxus.filter.less"](),
        },
        {
          value: DatabaseFilterOperator.LessOrEqual,
          label: t["com.myoxus.filter.less-or-equal"](),
        },
        {
          value: DatabaseFilterOperator.Between,
          label: t["com.myoxus.filter.between"](),
        },
        ...empty,
      ];
    case DatabaseFieldKind.Select:
      return [
        {
          value: DatabaseFilterOperator.Is,
          label: t["com.myoxus.filter.is"](),
        },
        {
          value: DatabaseFilterOperator.IsNot,
          label: t["com.myoxus.filter.is-not"](),
        },
        {
          value: DatabaseFilterOperator.AnyOf,
          label: t["com.myoxus.filter.any-of"](),
        },
        {
          value: DatabaseFilterOperator.NoneOf,
          label: t["com.myoxus.filter.none-of"](),
        },
        ...empty,
      ];
    case DatabaseFieldKind.Status:
      return [
        {
          value: DatabaseFilterOperator.Is,
          label: t["com.myoxus.filter.is"](),
        },
        {
          value: DatabaseFilterOperator.IsNot,
          label: t["com.myoxus.filter.is-not"](),
        },
        {
          value: DatabaseFilterOperator.AnyOf,
          label: t["com.myoxus.filter.any-of"](),
        },
        {
          value: DatabaseFilterOperator.NoneOf,
          label: t["com.myoxus.filter.none-of"](),
        },
        {
          value: DatabaseFilterOperator.GroupIs,
          label: t["com.myoxus.filter.group-is"](),
        },
        {
          value: DatabaseFilterOperator.GroupIsNot,
          label: t["com.myoxus.filter.group-is-not"](),
        },
        {
          value: DatabaseFilterOperator.GroupAnyOf,
          label: t["com.myoxus.filter.group-any-of"](),
        },
        {
          value: DatabaseFilterOperator.GroupNoneOf,
          label: t["com.myoxus.filter.group-none-of"](),
        },
        ...empty,
      ];
    case DatabaseFieldKind.User:
    case DatabaseFieldKind.Users:
      return [
        {
          value: DatabaseFilterOperator.ContainsUser,
          label: t["com.myoxus.filter.contains-user"](),
        },
        {
          value: DatabaseFilterOperator.DoesNotContainUser,
          label: t["com.myoxus.filter.does-not-contain-user"](),
        },
        {
          value: DatabaseFilterOperator.CurrentUser,
          label: t["com.myoxus.filter.current-user"](),
        },
        ...empty,
      ];
    case DatabaseFieldKind.Relation:
      return [
        {
          value: DatabaseFilterOperator.ContainsRow,
          label: t["com.myoxus.filter.contains-row"](),
        },
        {
          value: DatabaseFilterOperator.DoesNotContainRow,
          label: t["com.myoxus.filter.does-not-contain-row"](),
        },
        ...empty,
      ];
    default:
      return [
        {
          value: DatabaseFilterOperator.Contains,
          label: t["com.myoxus.filter.contains"](),
        },
        {
          value: DatabaseFilterOperator.DoesNotContain,
          label: t["com.myoxus.filter.does-not-contain"](),
        },
        {
          value: DatabaseFilterOperator.Is,
          label: t["com.myoxus.filter.is"](),
        },
        {
          value: DatabaseFilterOperator.IsNot,
          label: t["com.myoxus.filter.is-not"](),
        },
        {
          value: DatabaseFilterOperator.StartsWith,
          label: t["com.myoxus.filter.starts-with"](),
        },
        {
          value: DatabaseFilterOperator.EndsWith,
          label: t["com.myoxus.filter.ends-with"](),
        },
        ...empty,
      ];
  }
}

export function databaseRelativeDatePresetLabel(
  t: I18nShape,
  preset: DatabaseRelativeDatePreset,
) {
  switch (preset) {
    case DatabaseRelativeDatePreset.Today:
      return t["com.myoxus.database.filter.relative.today"]();
    case DatabaseRelativeDatePreset.Yesterday:
      return t["com.myoxus.database.filter.relative.yesterday"]();
    case DatabaseRelativeDatePreset.Tomorrow:
      return t["com.myoxus.database.filter.relative.tomorrow"]();
    case DatabaseRelativeDatePreset.Past7Days:
      return t["com.myoxus.database.filter.relative.past-seven-days"]();
    case DatabaseRelativeDatePreset.Next7Days:
      return t["com.myoxus.database.filter.relative.next-seven-days"]();
    case DatabaseRelativeDatePreset.CurrentWeek:
      return t["com.myoxus.filter.this week"]();
    case DatabaseRelativeDatePreset.CurrentMonth:
      return t["com.myoxus.filter.this month"]();
    case DatabaseRelativeDatePreset.CurrentYear:
      return t["com.myoxus.filter.this year"]();
    case DatabaseRelativeDatePreset.Overdue:
      return t["com.myoxus.database.filter.relative.overdue"]();
  }
}

export function databaseStatusGroupOptionLabel(
  t: I18nShape,
  group: DatabaseStatusGroup,
) {
  switch (group) {
    case DatabaseStatusGroup.NotStarted:
      return t["com.myoxus.database.progress.group.not-started"]();
    case DatabaseStatusGroup.Active:
      return t["com.myoxus.database.progress.group.active"]();
    case DatabaseStatusGroup.Complete:
      return t["com.myoxus.database.progress.group.complete"]();
    case DatabaseStatusGroup.Archived:
      return t["com.myoxus.database.progress.group.archived"]();
  }
}

export function databaseDensityLabel(
  t: I18nShape,
  density:
    DatabaseCardDensity | DatabaseGalleryCardDensity | DatabaseListDensity,
) {
  switch (density) {
    case DatabaseCardDensity.Compact:
      return t["com.myoxus.database.view.density.compact"]();
    case DatabaseCardDensity.Comfortable:
      return t["com.myoxus.database.view.density.comfortable"]();
    case DatabaseGalleryCardDensity.Large:
      return t["com.myoxus.database.view.density.large"]();
    default:
      return t["com.myoxus.database.view.density.default"]();
  }
}

export function databaseCalendarDateModeLabel(
  t: I18nShape,
  mode: DatabaseCalendarDateMode,
) {
  switch (mode) {
    case DatabaseCalendarDateMode.Day:
      return t["com.myoxus.database.view.period.day"]();
    case DatabaseCalendarDateMode.Week:
      return t["com.myoxus.database.view.period.week"]();
    case DatabaseCalendarDateMode.Year:
      return t["com.myoxus.database.view.period.year"]();
    case DatabaseCalendarDateMode.Month:
    default:
      return t["com.myoxus.database.view.period.month"]();
  }
}

export function databaseTimelineGroupLabel(
  t: I18nShape,
  group: DatabaseTimelineGroupBy,
) {
  return group === DatabaseTimelineGroupBy.None
    ? t["com.myoxus.page.display.grouping.no-grouping"]()
    : databaseCalendarDateModeLabel(
        t,
        group as unknown as DatabaseCalendarDateMode,
      );
}

export function databaseTimelineZoomLabel(
  t: I18nShape,
  zoom: DatabaseTimelineZoom,
) {
  if (zoom === DatabaseTimelineZoom.Quarter) {
    return t["com.myoxus.database.view.period.quarter"]();
  }
  return databaseCalendarDateModeLabel(
    t,
    zoom as unknown as DatabaseCalendarDateMode,
  );
}

export function databaseViewControlTitle(
  t: I18nShape,
  section: DatabaseViewControlSection,
) {
  switch (section) {
    case "filter":
      return t["com.myoxus.filter"]();
    case "sort":
      return t["com.myoxus.database.view.sort-field"]();
    case "group":
      return t["com.myoxus.page.display.grouping"]();
    case "fields":
      return t["com.myoxus.database.fields"]();
    case "display":
      return t["com.myoxus.page.display"]();
    case "advanced":
      return t["com.myoxus.database.view.advanced"]();
  }
}

export function databaseViewSystemIconLabel(
  t: I18nShape,
  icon: DatabaseViewSystemIcon,
) {
  switch (icon) {
    case DatabaseViewSystemIcon.Board:
      return databaseViewKindLabel(t, DatabaseViewKind.Kanban);
    case DatabaseViewSystemIcon.Database:
      return t["com.myoxus.database.view.icon.database"]();
    case DatabaseViewSystemIcon.Project:
      return t["com.myoxus.database.view.icon.project"]();
    default:
      return databaseViewKindLabel(t, icon as unknown as DatabaseViewKind);
  }
}

export function databaseFieldSupportsSavedFilters(field: DatabaseField) {
  return ![
    DatabaseFieldKind.CreatedBy,
    DatabaseFieldKind.DocumentLink,
    DatabaseFieldKind.Files,
    DatabaseFieldKind.Formula,
    DatabaseFieldKind.Rollup,
    DatabaseFieldKind.UpdatedBy,
  ].includes(field.fieldType);
}

export function databaseFieldSupportsGrouping(field: DatabaseField) {
  return [
    DatabaseFieldKind.Checkbox,
    DatabaseFieldKind.CreatedTime,
    DatabaseFieldKind.Date,
    DatabaseFieldKind.DateTime,
    DatabaseFieldKind.MultiSelect,
    DatabaseFieldKind.Select,
    DatabaseFieldKind.Status,
    DatabaseFieldKind.Tags,
    DatabaseFieldKind.UpdatedTime,
    DatabaseFieldKind.User,
    DatabaseFieldKind.Users,
  ].includes(field.fieldType);
}

export function databaseFieldSupportsProgressGrouping(field: DatabaseField) {
  return (
    databaseFieldSupportsGrouping(field) ||
    field.fieldType === DatabaseFieldKind.Relation
  );
}

export function databaseProgressGroupFilterRule(
  field: DatabaseField,
  key: string,
): DatabaseFilterRuleInput | null {
  if (key === "__empty__") {
    return {
      fieldId: field.id,
      operator: DatabaseFilterOperator.Empty,
      value: { none: true },
    };
  }
  switch (field.fieldType) {
    case DatabaseFieldKind.Status:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.GroupIs,
        value: { optionId: key },
      };
    case DatabaseFieldKind.Select:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.Is,
        value: { optionId: key },
      };
    case DatabaseFieldKind.MultiSelect:
    case DatabaseFieldKind.Tags:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.Contains,
        value: { optionId: key },
      };
    case DatabaseFieldKind.User:
    case DatabaseFieldKind.Users:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.ContainsUser,
        value: { userId: key },
      };
    case DatabaseFieldKind.Relation:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.ContainsRow,
        value: { relationRowId: key },
      };
    case DatabaseFieldKind.Checkbox:
      return {
        fieldId: field.id,
        operator:
          key === "true"
            ? DatabaseFilterOperator.Checked
            : DatabaseFilterOperator.Unchecked,
        value: { none: true },
      };
    case DatabaseFieldKind.Date:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.On,
        value: { date: key },
      };
    case DatabaseFieldKind.DateTime:
      return {
        fieldId: field.id,
        operator: DatabaseFilterOperator.On,
        value: { instant: key },
      };
    default:
      return null;
  }
}

export function stripDatabaseFilterField(
  group: DatabaseFilterGroupInput,
  fieldId: string,
): DatabaseFilterGroupInput {
  return {
    conjunction: group.conjunction,
    rules: (group.rules ?? []).filter((rule) => rule.fieldId !== fieldId),
    groups: (group.groups ?? [])
      .map((nested) => stripDatabaseFilterField(nested, fieldId))
      .filter(
        (nested) =>
          (nested.rules?.length ?? 0) > 0 || (nested.groups?.length ?? 0) > 0,
      ),
  };
}

export function applyDatabaseProgressGroupFilter(
  current: DatabaseFilterGroupInput | null,
  rule: DatabaseFilterRuleInput,
): DatabaseFilterGroupInput {
  const stripped = current
    ? stripDatabaseFilterField(current, rule.fieldId)
    : createDatabaseFilterGroup();
  if (stripped.conjunction === DatabaseFilterConjunction.And) {
    return { ...stripped, rules: [...(stripped.rules ?? []), rule] };
  }
  const hasExisting =
    (stripped.rules?.length ?? 0) > 0 || (stripped.groups?.length ?? 0) > 0;
  return {
    conjunction: DatabaseFilterConjunction.And,
    rules: [rule],
    groups: hasExisting ? [stripped] : [],
  };
}

export function databaseFilterOperatorNeedsValue(
  operator: DatabaseFilterOperator,
) {
  return ![
    DatabaseFilterOperator.Checked,
    DatabaseFilterOperator.CurrentUser,
    DatabaseFilterOperator.Empty,
    DatabaseFilterOperator.NotEmpty,
    DatabaseFilterOperator.Unchecked,
  ].includes(operator);
}

export function createDatabaseFilterRule(
  field: DatabaseField,
): DatabaseFilterRuleInput {
  const operator =
    field.fieldType === DatabaseFieldKind.Checkbox
      ? DatabaseFilterOperator.Checked
      : field.fieldType === DatabaseFieldKind.Date ||
          field.fieldType === DatabaseFieldKind.DateTime ||
          field.fieldType === DatabaseFieldKind.CreatedTime ||
          field.fieldType === DatabaseFieldKind.UpdatedTime
        ? DatabaseFilterOperator.On
        : field.fieldType === DatabaseFieldKind.Number ||
            field.fieldType === DatabaseFieldKind.Percent ||
            field.fieldType === DatabaseFieldKind.Currency ||
            field.fieldType === DatabaseFieldKind.Duration
          ? DatabaseFilterOperator.Equals
          : field.fieldType === DatabaseFieldKind.Select ||
              field.fieldType === DatabaseFieldKind.Status
            ? DatabaseFilterOperator.Is
            : field.fieldType === DatabaseFieldKind.User ||
                field.fieldType === DatabaseFieldKind.Users
              ? DatabaseFilterOperator.CurrentUser
              : field.fieldType === DatabaseFieldKind.Relation
                ? DatabaseFilterOperator.Empty
                : DatabaseFilterOperator.Contains;
  return {
    fieldId: field.id,
    operator,
    value: databaseFilterDefaultValue(field, operator),
  };
}

export function databaseFilterDefaultValue(
  field: DatabaseField,
  operator: DatabaseFilterOperator,
): DatabaseFilterValueInput {
  if (!databaseFilterOperatorNeedsValue(operator)) return { none: true };
  if (operator === DatabaseFilterOperator.Relative) {
    return { relativeDate: DatabaseRelativeDatePreset.Today };
  }
  if (operator === DatabaseFilterOperator.Between) {
    if (field.fieldType === DatabaseFieldKind.Currency) {
      return {
        currencyRange: {
          currencyCode: field.config.currency?.defaultCurrency || "EUR",
          start: 0,
        },
      };
    }
    if (field.fieldType === DatabaseFieldKind.Duration) {
      return { durationRange: { startMinutes: 0 } };
    }
    if (field.fieldType === DatabaseFieldKind.Date) {
      return { dateRange: { start: new Date().toISOString().slice(0, 10) } };
    }
    if (
      [
        DatabaseFieldKind.DateTime,
        DatabaseFieldKind.CreatedTime,
        DatabaseFieldKind.UpdatedTime,
      ].includes(field.fieldType)
    ) {
      return { instantRange: { start: new Date().toISOString() } };
    }
    return { numberRange: { start: 0 } };
  }
  if (field.fieldType === DatabaseFieldKind.Currency) {
    return {
      currency: {
        amount: 0,
        currencyCode: field.config.currency?.defaultCurrency || "EUR",
      },
    };
  }
  if (field.fieldType === DatabaseFieldKind.Duration) {
    return { duration: { minutes: 0 } };
  }
  if (
    [
      DatabaseFieldKind.Number,
      DatabaseFieldKind.Percent,
      DatabaseFieldKind.UniqueId,
    ].includes(field.fieldType)
  ) {
    return { number: 0 };
  }
  if (field.fieldType === DatabaseFieldKind.Date) {
    return { date: new Date().toISOString().slice(0, 10) };
  }
  if (
    [
      DatabaseFieldKind.DateTime,
      DatabaseFieldKind.CreatedTime,
      DatabaseFieldKind.UpdatedTime,
    ].includes(field.fieldType)
  ) {
    return { instant: new Date().toISOString() };
  }
  if (
    [
      DatabaseFilterOperator.AnyOf,
      DatabaseFilterOperator.NoneOf,
      DatabaseFilterOperator.GroupAnyOf,
      DatabaseFilterOperator.GroupNoneOf,
      DatabaseFilterOperator.ContainsAll,
    ].includes(operator)
  ) {
    return { ids: [] };
  }
  if (
    [
      DatabaseFilterOperator.Is,
      DatabaseFilterOperator.IsNot,
      DatabaseFilterOperator.GroupIs,
      DatabaseFilterOperator.GroupIsNot,
      DatabaseFilterOperator.Contains,
      DatabaseFilterOperator.DoesNotContain,
    ].includes(operator) &&
    [
      DatabaseFieldKind.Select,
      DatabaseFieldKind.Status,
      DatabaseFieldKind.MultiSelect,
      DatabaseFieldKind.Tags,
    ].includes(field.fieldType)
  ) {
    return { optionId: "" };
  }
  if (
    [
      DatabaseFilterOperator.ContainsUser,
      DatabaseFilterOperator.DoesNotContainUser,
    ].includes(operator)
  ) {
    return { userId: "" };
  }
  if (
    [
      DatabaseFilterOperator.ContainsRow,
      DatabaseFilterOperator.DoesNotContainRow,
    ].includes(operator)
  ) {
    return { relationRowId: "" };
  }
  return { text: "" };
}

export function databaseFilterRuleIsComplete(rule: DatabaseFilterRuleInput) {
  if (!databaseFilterOperatorNeedsValue(rule.operator)) return true;
  const value = rule.value;
  if (value.text != null) return value.text.trim().length > 0;
  if (value.number != null) return Number.isFinite(value.number);
  if (value.optionId != null) return value.optionId.length > 0;
  if (value.ids != null) return value.ids.length > 0;
  if (value.userId != null) return value.userId.length > 0;
  if (value.relationRowId != null) return value.relationRowId.length > 0;
  if (value.date != null || value.instant != null || value.relativeDate != null)
    return true;
  if (value.currency != null)
    return (
      Number.isFinite(value.currency.amount) &&
      Boolean(value.currency.currencyCode)
    );
  if (value.duration != null) return value.duration.minutes >= 0;
  return (
    value.numberRange != null ||
    value.currencyRange != null ||
    value.durationRange != null ||
    value.dateRange != null ||
    value.instantRange != null
  );
}
