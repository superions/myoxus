// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  RecurrenceFrequency,
  RecurrenceMode,
  RecurrenceRelativeUnit,
  RecurrenceWeekday,
  type RecurrenceRuleInput,
  type RecurrenceValueInput,
  type RecurrenceRuleFieldsFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  FormSelect,
  Group,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  MultiSelect,
  NumberInput,
  Stack,
  Switch,
} from "@myoxus/ui-facade";

export type RecurrenceDraft = {
  mode: RecurrenceMode;
  frequency: RecurrenceFrequency;
  interval: number | string;
  unit: RecurrenceRelativeUnit;
  dateOnly: boolean;
  start: string;
  end: string;
  zone: string;
  weekdays: RecurrenceWeekday[];
  day: number | string;
  lastDay: boolean;
  month: number | string;
  completionReference: string;
};

const weekdays = Object.values(RecurrenceWeekday);
const weekdayOrder = [
  RecurrenceWeekday.Monday,
  RecurrenceWeekday.Tuesday,
  RecurrenceWeekday.Wednesday,
  RecurrenceWeekday.Thursday,
  RecurrenceWeekday.Friday,
  RecurrenceWeekday.Saturday,
  RecurrenceWeekday.Sunday,
];
const zones = [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])].map(
  (value) => ({ value, label: value }),
);

/** Civil transport only: the server owns validation, zone resolution and every
 * recurrence calculation. Never convert a date-only draft into an instant. */
export function recurrenceValue(
  value: string,
  dateOnly: boolean,
): RecurrenceValueInput | null {
  if (!value) return null;
  return dateOnly
    ? { date: value.slice(0, 10) }
    : { localDateTime: value.replace(" ", "T") };
}

export function recurrenceRule(
  draft: RecurrenceDraft,
): RecurrenceRuleInput | null {
  const interval = Number(draft.interval);
  if (!Number.isSafeInteger(interval) || interval < 1 || !draft.zone)
    return null;
  if (draft.mode === RecurrenceMode.AfterCompletion)
    return {
      afterCompletion: { amount: interval, unit: draft.unit, zone: draft.zone },
    };
  const start = recurrenceValue(draft.start, draft.dateOnly);
  if (!start) return null;
  return {
    fixed: {
      frequency: draft.frequency,
      interval,
      start,
      end: recurrenceValue(draft.end, draft.dateOnly),
      zone: draft.zone,
      ...(draft.frequency === RecurrenceFrequency.Weekly
        ? { weekdays: draft.weekdays }
        : {}),
      ...(draft.frequency === RecurrenceFrequency.Monthly
        ? draft.lastDay
          ? { lastDay: true }
          : { day: Number(draft.day) }
        : {}),
      ...(draft.frequency === RecurrenceFrequency.Yearly
        ? { month: Number(draft.month), day: Number(draft.day) }
        : {}),
    },
  };
}

export function recurrenceDraft(
  rule: RecurrenceRuleFieldsFragment,
  reference: string,
): RecurrenceDraft {
  return {
    mode: rule.mode,
    frequency: rule.frequency ?? RecurrenceFrequency.Daily,
    interval: rule.interval,
    unit: rule.relativeUnit ?? RecurrenceRelativeUnit.Days,
    dateOnly: rule.dateOnly,
    start: rule.start?.date ?? rule.start?.localDateTime ?? reference,
    end: rule.end?.date ?? rule.end?.localDateTime ?? "",
    zone: rule.zone,
    weekdays: rule.weekdays,
    day: rule.day ?? 1,
    lastDay: rule.lastDay,
    month: rule.month ?? 1,
    completionReference: reference,
  };
}

/** Shared native rule form for Tasks and Calendar; drafts have no persistence
 * side effects. A consuming owner explicitly confirms the complete rule. */
export function RecurrenceRuleFields({
  value,
  onChange,
  disabled,
  allowCompletion = true,
  boundStart = false,
}: {
  value: RecurrenceDraft;
  onChange: (value: RecurrenceDraft) => void;
  disabled?: boolean;
  allowCompletion?: boolean;
  /** Calendar's event form already owns DTSTART and date kind. */
  boundStart?: boolean;
}) {
  const t = useI18n();
  const change = (patch: Partial<RecurrenceDraft>) =>
    onChange({ ...value, ...patch });
  const date = (
    label: string,
    key: "start" | "end" | "completionReference",
    optional = false,
  ) =>
    value.dateOnly ? (
      <LocalizedDateInput
        label={label}
        locale={t.language}
        value={value[key]?.slice(0, 10) || null}
        clearable={optional}
        disabled={disabled}
        onChange={(next) =>
          change({ [key]: typeof next === "string" ? next : "" })
        }
      />
    ) : (
      <LocalizedDateTimeInput
        label={label}
        locale={t.language}
        value={value[key]?.replace("T", " ") || null}
        clearable={optional}
        disabled={disabled}
        onChange={(next) =>
          change({ [key]: typeof next === "string" ? next : "" })
        }
      />
    );
  const fixed = value.mode === RecurrenceMode.Fixed;
  return (
    <Stack>
      {allowCompletion ? (
        <FormSelect
          label={t["com.myoxus.recurrence.mode"]()}
          value={value.mode}
          disabled={disabled}
          allowDeselect={false}
          data={[
            {
              value: RecurrenceMode.Fixed,
              label: t["com.myoxus.recurrence.fixed"](),
            },
            {
              value: RecurrenceMode.AfterCompletion,
              label: t["com.myoxus.recurrence.after-completion"](),
            },
          ]}
          onChange={(mode) => change({ mode: mode as RecurrenceMode })}
        />
      ) : null}
      <Group grow>
        <NumberInput
          label={t["com.myoxus.recurrence.interval"]()}
          value={value.interval}
          min={1}
          allowDecimal={false}
          disabled={disabled}
          onChange={(interval) => change({ interval })}
        />
        {fixed ? (
          <FormSelect
            label={t["com.myoxus.recurrence.frequency"]()}
            value={value.frequency}
            allowDeselect={false}
            disabled={disabled}
            data={[
              {
                value: RecurrenceFrequency.Daily,
                label: t["com.myoxus.recurrence.daily"](),
              },
              {
                value: RecurrenceFrequency.Weekly,
                label: t["com.myoxus.recurrence.weekly"](),
              },
              {
                value: RecurrenceFrequency.Monthly,
                label: t["com.myoxus.recurrence.monthly"](),
              },
              {
                value: RecurrenceFrequency.Yearly,
                label: t["com.myoxus.recurrence.yearly"](),
              },
            ]}
            onChange={(frequency) =>
              change({ frequency: frequency as RecurrenceFrequency })
            }
          />
        ) : (
          <FormSelect
            label={t["com.myoxus.recurrence.unit"]()}
            value={value.unit}
            allowDeselect={false}
            disabled={disabled}
            data={[
              {
                value: RecurrenceRelativeUnit.Days,
                label: t["com.myoxus.recurrence.days"](),
              },
              {
                value: RecurrenceRelativeUnit.Weeks,
                label: t["com.myoxus.recurrence.weeks"](),
              },
              {
                value: RecurrenceRelativeUnit.Months,
                label: t["com.myoxus.recurrence.months"](),
              },
            ]}
            onChange={(unit) =>
              change({ unit: unit as RecurrenceRelativeUnit })
            }
          />
        )}
      </Group>
      {fixed && value.frequency === RecurrenceFrequency.Weekly ? (
        <MultiSelect
          label={t["com.myoxus.recurrence.weekdays"]()}
          value={value.weekdays}
          disabled={disabled}
          data={weekdayOrder.map((day, index) => ({
            value: day,
            label: new Intl.DateTimeFormat(t.language, {
              weekday: "long",
              timeZone: "UTC",
            }).format(new Date(Date.UTC(2024, 0, 1 + index))),
          }))}
          onChange={(days) =>
            change({
              weekdays: days.filter((day): day is RecurrenceWeekday =>
                weekdays.includes(day as RecurrenceWeekday),
              ),
            })
          }
        />
      ) : null}
      {fixed && value.frequency === RecurrenceFrequency.Monthly ? (
        <Switch
          checked={value.lastDay}
          disabled={disabled}
          onChange={(lastDay) => change({ lastDay })}
        >
          {t["com.myoxus.recurrence.last-day"]()}
        </Switch>
      ) : null}
      {fixed &&
      (value.frequency === RecurrenceFrequency.Yearly ||
        (value.frequency === RecurrenceFrequency.Monthly && !value.lastDay)) ? (
        <Group grow>
          {value.frequency === RecurrenceFrequency.Yearly ? (
            <FormSelect
              label={t["com.myoxus.recurrence.month"]()}
              value={String(value.month)}
              disabled={disabled}
              allowDeselect={false}
              data={Array.from({ length: 12 }, (_, month) => ({
                value: String(month + 1),
                label: new Intl.DateTimeFormat(t.language, {
                  month: "long",
                  timeZone: "UTC",
                }).format(new Date(Date.UTC(2024, month, 1))),
              }))}
              onChange={(month) => change({ month: Number(month) })}
            />
          ) : null}
          <NumberInput
            label={t["com.myoxus.recurrence.month-day"]()}
            value={value.day}
            min={1}
            max={31}
            allowDecimal={false}
            disabled={disabled}
            onChange={(day) => change({ day })}
          />
        </Group>
      ) : null}
      {fixed && !boundStart ? (
        <Switch
          checked={value.dateOnly}
          disabled={disabled}
          onChange={(dateOnly) => {
            const convert = (date: string) =>
              !date
                ? ""
                : dateOnly
                  ? date.slice(0, 10)
                  : date.includes("T") || date.includes(" ")
                    ? date
                    : `${date}T09:00:00`;
            change({
              dateOnly,
              start: convert(value.start),
              end: convert(value.end),
            });
          }}
        >
          {t["com.myoxus.integration.calendar.all-day"]()}
        </Switch>
      ) : null}
      <Group grow>
        {fixed ? (
          <>
            {!boundStart
              ? date(t["com.myoxus.common.start-date"](), "start")
              : null}
            {date(t["com.myoxus.recurrence.end"](), "end", true)}
          </>
        ) : (
          date(
            t["com.myoxus.recurrence.completion-reference"](),
            "completionReference",
          )
        )}
      </Group>
      <FormSelect
        label={t["com.myoxus.common.timezone"]()}
        description={t["com.myoxus.recurrence.zone-hint"]()}
        value={value.zone}
        searchable
        allowDeselect={false}
        disabled={disabled}
        data={
          zones.some((zone) => zone.value === value.zone)
            ? zones
            : [{ value: value.zone, label: value.zone }, ...zones]
        }
        onChange={(zone) => change({ zone })}
      />
    </Stack>
  );
}
