// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Checkbox,
  Divider,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  formatGanttDateValue,
  parseGanttDateValue,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { useGanttOptionDrafts } from "./option-drafts";

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** Each draft belongs to one source statement; preview never writes task source. */
export function GanttCalendarPopover({
  props,
  onClose,
  optionsPortalTarget,
}: {
  readonly props: MermaidGanttReactHostProps;
  readonly onClose: () => void;
  readonly optionsPortalTarget: string;
}) {
  const draft = useGanttOptionDrafts(props.model);
  const [custom, setCustom] = useState("");
  const [customInclude, setCustomInclude] = useState("");
  const preview = draft.commands.length
    ? props.onPreviewCommand(draft.commands)
    : null;
  const effective = preview?.model.calendar ?? props.model.calendar;
  const dateFormat = draft.value("dateFormat", effective.dateFormat);
  const scheduleChanges = preview?.changed
    ? props.model.tasks.flatMap((task) => {
        const before = props.model.intervals[task.recordId];
        const after = preview.model.intervals[task.recordId];
        return before &&
          after &&
          (before.start !== after.start || before.end !== after.end)
          ? [{ task, before, after }]
          : [];
      })
    : [];
  const intervalLabel = (interval: { start: number; end: number }) =>
    `${formatGanttDateValue(interval.start, effective.dateFormat)} → ${formatGanttDateValue(interval.end, effective.dateFormat, undefined, "end")}`;
  const list = (name: "includes" | "excludes") =>
    draft
      .value(name)
      .toLowerCase()
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  const invalidDate = (value: string) =>
    Boolean(value.trim()) &&
    (/\s/.test(value.trim()) ||
      (parseGanttDateValue(value.trim(), dateFormat.trim()) === null &&
        parseGanttDateValue(value.trim(), "YYYY-MM-DD") === null));
  const toggle = (
    name: "includes" | "excludes",
    entry: string,
    checked: boolean,
  ) => {
    const before = list(name);
    draft.setValue(
      name,
      (checked
        ? [...new Set([...before, entry])]
        : before.filter((value) => value !== entry)
      ).join(","),
    );
  };
  return (
    <Stack p="sm" w={360}>
      <MyoxusText typographySlot="dense-label">
        {messages.ganttCalendar()}
      </MyoxusText>
      {draft.controls(
        "dateFormat",
        messages.ganttDateFormat(),
        effective.dateFormat,
      )}
      <MyoxusTextInput
        label={messages.ganttDateFormat()}
        description="YYYY-MM-DD"
        value={dateFormat}
        onChange={(value) => draft.setValue("dateFormat", value)}
      />
      {draft.controls(
        "inclusiveEndDates",
        messages.ganttInclusiveEnd(),
        String(effective.inclusiveEndDates === true),
      )}
      <Checkbox
        label={messages.ganttInclusiveEnd()}
        checked={draft.value("inclusiveEndDates", "false") !== "false"}
        onChange={(event) =>
          event.target.checked
            ? draft.setValue("inclusiveEndDates", "")
            : draft.reset("inclusiveEndDates")
        }
      />
      {(["weekday", "weekend"] as const).map((name) => (
        <Stack key={name} gap="xs">
          {draft.controls(
            name,
            name === "weekday"
              ? messages.ganttWeekdayStart()
              : messages.ganttWeekendStart(),
            effective[name] ?? "—",
          )}
          <Select
            comboboxProps={{
              withinPortal: true,
              portalProps: { target: optionsPortalTarget },
            }}
            clearable
            label={
              name === "weekday"
                ? messages.ganttWeekdayStart()
                : messages.ganttWeekendStart()
            }
            data={(name === "weekday" ? WEEKDAYS : ["friday", "saturday"]).map(
              (value) => ({ value, label: value }),
            )}
            value={draft.value(name) || null}
            onChange={(value) => {
              if (value) draft.setValue(name, value);
              else draft.reset(name);
            }}
          />
        </Stack>
      ))}
      <Divider />
      {(["excludes", "includes"] as const).map((name) => {
        const label =
          name === "includes"
            ? messages.ganttIncludes()
            : messages.ganttExcludes();
        const value = name === "includes" ? customInclude : custom;
        const setCustomValue =
          name === "includes" ? setCustomInclude : setCustom;
        const entries =
          name === "excludes"
            ? [...new Set(["weekends", ...WEEKDAYS, ...list(name)])]
            : list(name);
        return (
          <Stack key={name} gap="xs">
            {draft.controls(name, label, effective[name].join(","))}
            <MyoxusText typographySlot="body-small">{label}</MyoxusText>
            <Group gap="xs" wrap="wrap">
              {entries.map((entry) => (
                <Checkbox
                  key={entry}
                  label={entry}
                  checked={list(name).includes(entry)}
                  onChange={(event) =>
                    toggle(name, entry, event.target.checked)
                  }
                />
              ))}
            </Group>
            <MyoxusTextInput
              label={label}
              description={dateFormat}
              value={value}
              onChange={setCustomValue}
              error={
                invalidDate(value)
                  ? messages.ganttDiagnosticInvalidDate(value)
                  : undefined
              }
            />
            <Button
              disabled={!value.trim() || invalidDate(value)}
              variant="ghost"
              onClick={() => {
                toggle(name, value.trim(), true);
                setCustomValue("");
              }}
            >
              {messages.structuredAddEntry()}
            </Button>
          </Stack>
        );
      })}
      {scheduleChanges.length ? (
        <Stack gap="xs">
          <MyoxusText typographySlot="dense-label">
            {messages.ganttSchedule()}
          </MyoxusText>
          {scheduleChanges.map(({ task, before, after }) => (
            <Stack gap="xs" key={task.recordId}>
              <MyoxusText typographySlot="body-small">{task.label}</MyoxusText>
              <MyoxusText typographySlot="caption">
                {`${messages.ganttImpactBefore()}: ${intervalLabel(before)}`}
              </MyoxusText>
              <MyoxusText typographySlot="caption">
                {`${messages.ganttImpactAfter()}: ${intervalLabel(after)}`}
              </MyoxusText>
            </Stack>
          ))}
        </Stack>
      ) : null}
      <Group justify="flex-end">
        <Button
          variant="ghost"
          onClick={() => {
            draft.cancel();
            setCustom("");
            setCustomInclude("");
            onClose();
          }}
        >
          {messages.cancel()}
        </Button>
        <Button
          disabled={
            props.readonly ||
            !preview?.changed ||
            invalidDate(custom) ||
            invalidDate(customInclude) ||
            Boolean(custom.trim() || customInclude.trim())
          }
          variant="secondary"
          onClick={() => {
            if (preview?.changed && props.onCommand(draft.commands).changed)
              onClose();
          }}
        >
          {messages.architectureApply()}
        </Button>
      </Group>
      {draft.conflicted ||
      (preview && !preview.changed && preview.diagnosis !== "no-change") ? (
        <MyoxusText tone="danger" typographySlot="caption">
          {draft.conflicted
            ? messages.ganttDiagnosticConflict()
            : messages.ganttDiagnosticInvalidSchedule()}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}
