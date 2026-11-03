// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  CalendarEventOrigin,
  CalendarTimingAction,
  NativeEventScope,
  RecurrenceFrequency,
  RecurrenceLifecycle,
  RecurrenceMode,
  RecurrenceRelativeUnit,
  type CalendarEventQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Checkbox,
  DialogFooterActions,
  FormSelect,
  Group,
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Modal,
  MyoxusText,
  ResponsiveGrid,
  SettingsNotice,
  Stack,
  Switch,
  Textarea,
  notify,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import useSWR from "swr";

import { databaseZonedDateTime } from "../../../modules/database/shared/schedule";
import { IntegrationService } from "../../../modules/integration";
import {
  RecurrencePreview,
  useRecurrencePreview,
} from "../../../modules/recurrence/preview";
import {
  recurrenceDraft,
  recurrenceRule,
  RecurrenceRuleFields,
  type RecurrenceDraft,
} from "../../../modules/recurrence/rule-fields";
import { eventReminderPatch } from "./event-edit-input";

type Props = DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["event-edit"]>;
type EventDetails = NonNullable<CalendarEventQuery["calendarEvent"]>;
type Snapshot = {
  existingEvent: EventDetails | null;
  master: EventDetails | null;
};
type Form = {
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  allMembers: boolean;
  reminderMinutes: number | "";
  reminderChannel: string;
  tagId: string;
  description: string;
  repeat: boolean;
  rule: RecurrenceDraft;
};
type Command = "skip" | "end" | "delete" | { scope: NativeEventScope };

function descriptionText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("delta" in value && Array.isArray(value.delta)) {
    return value.delta
      .map((entry) =>
        entry && typeof entry === "object" && typeof entry.insert === "string"
          ? entry.insert
          : "",
      )
      .join("");
  }
  return "";
}

/** Pickers display seconds, but an unchanged authored DTSTART can carry
 * microseconds. Preserve that transport precision instead of retiming a series
 * when only its title or rule selector is edited. */
function preciseCivil(value: string, source: string | undefined) {
  return `${value.replace(/\.\d+$/, "")}${source?.match(/\.\d+/)?.[0] ?? ""}`;
}

/** Date picker ends are inclusive; Calendar's wire end is an exclusive DATE
 * boundary. This is input formatting, not recurrence/admission calculation. */
function dateBoundary(value: string, end = false) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function initialForm(
  snapshot: Snapshot,
  scope: NativeEventScope,
  occurrence: Props["occurrence"],
  defaultDate: string | undefined,
  zone: string,
  defaultReminder: number | null | undefined,
): Form {
  const { existingEvent, master } = snapshot;
  const event = scope === NativeEventScope.All ? master : existingEvent;
  const timing = master?.recurrence;
  const pin = timing?.zone ?? zone;
  const now = databaseZonedDateTime(new Date().toISOString(), pin);
  const startDefault = dayjs(now)
    .startOf("hour")
    .add(1, "hour")
    .format("YYYY-MM-DDTHH:mm:ss");
  const starts =
    scope !== NativeEventScope.All
      ? (occurrence?.startsAt ?? event?.startsAt)
      : event?.startsAt;
  const ends =
    scope !== NativeEventScope.All
      ? (occurrence?.endsAt ?? event?.endsAt)
      : event?.endsAt;
  const allDay = event?.allDay ?? false;
  const startsAt = starts
    ? allDay
      ? starts.slice(0, 10)
      : databaseZonedDateTime(starts, pin).replace(" ", "T")
    : `${defaultDate ?? startDefault.slice(0, 10)}T${startDefault.slice(11)}`;
  const endsAt = ends
    ? allDay
      ? new Date(new Date(ends).getTime() - 1).toISOString().slice(0, 10)
      : databaseZonedDateTime(ends, pin).replace(" ", "T")
    : dayjs(startsAt).add(1, "hour").format("YYYY-MM-DDTHH:mm:ss");
  const rule = timing?.rule
    ? recurrenceDraft(timing.rule, startsAt)
    : {
        mode: RecurrenceMode.Fixed,
        frequency: RecurrenceFrequency.Daily,
        interval: 1,
        unit: RecurrenceRelativeUnit.Days,
        dateOnly: allDay,
        start: startsAt,
        end: "",
        zone: pin,
        weekdays: [],
        day: Number(startsAt.slice(8, 10)),
        lastDay: false,
        month: Number(startsAt.slice(5, 7)),
        completionReference: "",
      };
  return {
    title:
      scope !== NativeEventScope.All
        ? (occurrence?.title ?? event?.title ?? "")
        : (event?.title ?? ""),
    startsAt,
    endsAt,
    allDay,
    allMembers: event?.allMembers ?? false,
    reminderMinutes:
      event?.reminders[0]?.minutesBefore ??
      (event ? "" : (defaultReminder ?? "")),
    reminderChannel: event?.reminders[0]?.channel ?? "in_app",
    tagId: event?.tagId ?? "",
    description: descriptionText(event?.descriptionDelta),
    repeat: Boolean(timing),
    rule,
  };
}

export function EventEditDialog(props: Props) {
  const t = useI18n();
  const calendar = useService(IntegrationService).calendar;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState(props.eventId);
  const [dirty, setDirty] = useState(false);
  const workspace = useService(WorkspaceService).workspace;
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const account = useLiveData(server?.account$);
  const series = useSWR(
    !props.eventId && server && account
      ? [
          "calendar-authored-series",
          workspace.id,
          server.id,
          server.baseUrl,
          account.id,
        ]
      : null,
    () => calendar.listSeries(),
    { suspense: false, revalidateOnFocus: false, shouldRetryOnError: false },
  );
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError(false);
    void (async () => {
      if (!selectedEventId) {
        await calendar.getSettings();
        if (active) setSnapshot({ existingEvent: null, master: null });
        return;
      }
      const event = await calendar.revalidateEventDetails(selectedEventId);
      if (!event) throw new Error("Calendar event unavailable");
      const master = event.recurrenceParentId
        ? await calendar.revalidateEventDetails(event.recurrenceParentId)
        : event;
      if (!master) throw new Error("Calendar master unavailable");
      if (active) setSnapshot({ existingEvent: event, master });
    })().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [calendar, selectedEventId, attempt]);
  return (
    <Modal
      open
      scrollable
      persistent={pending}
      onOpenChange={(open) => {
        if (!open && !pending) props.close(null);
      }}
      title={
        selectedEventId
          ? t["com.myoxus.integration.calendar.event-edit"]()
          : t["com.myoxus.integration.calendar.add-event"]()
      }
    >
      <Stack>
        {!props.eventId && !selectedEventId ? (
          <Stack>
            <FormSelect
              label={t[
                "com.myoxus.integration.calendar.event-dialog.saved-series"
              ]()}
              searchable
              value=""
              data={(series.data ?? []).map((event) => ({
                value: event.id,
                label:
                  event.title ??
                  t["com.myoxus.integration.calendar.untitled-event"](),
              }))}
              disabled={pending || dirty || series.isLoading}
              onChange={(value) => {
                if (value) setSelectedEventId(value);
              }}
            />
            {series.error ? (
              <SettingsNotice tone="error">
                <Stack>
                  <MyoxusText>
                    {t["com.myoxus.editor.event.unavailable"]()}
                  </MyoxusText>
                  <Button onClick={() => void series.mutate()}>
                    {t.Retry()}
                  </Button>
                </Stack>
              </SettingsNotice>
            ) : null}
          </Stack>
        ) : null}
        {snapshot ? (
          <EventEditSession
            {...props}
            key={selectedEventId ?? "new"}
            eventId={selectedEventId}
            snapshot={snapshot}
            pending={pending}
            setPending={setPending}
            onDirtyChange={setDirty}
          />
        ) : (
          <Stack data-testid="event-edit-dialog-load-state">
            <SettingsNotice
              role={error ? "alert" : "status"}
              tone={error ? "error" : "info"}
            >
              {error ? t["com.myoxus.editor.event.unavailable"]() : t.Loading()}
            </SettingsNotice>
            <DialogFooterActions>
              <Button variant="plain" onClick={() => props.close(null)}>
                {t.Cancel()}
              </Button>
              {error ? (
                <Button onClick={() => setAttempt((value) => value + 1)}>
                  {t.Retry()}
                </Button>
              ) : null}
            </DialogFooterActions>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

/** Capture one editing basis for the open form. Live cache hydration must not
 * overwrite unsaved fields; revision-fenced lifecycle errors retain this draft. */
function EventEditSession({
  close,
  eventId,
  occurrence,
  defaultDate,
  sourceDocId,
  intent,
  snapshot,
  pending,
  setPending,
  onDirtyChange,
}: Props & {
  snapshot: Snapshot;
  pending: boolean;
  setPending: (value: boolean) => void;
  onDirtyChange: (value: boolean) => void;
}) {
  const t = useI18n();
  const calendar = useService(IntegrationService).calendar;
  const regional = useRegionalPreferences();
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const account = useLiveData(server?.account$);
  const workspace = useService(WorkspaceService).workspace;
  const canManage = Boolean(
    useLiveData(useService(GuardService).can$("Workspace_CreateDoc")),
  );
  const tags = useLiveData(calendar.tags$);
  const settings = useLiveData(calendar.settings$);
  const { existingEvent, master } = snapshot;
  const [timing, setTiming] = useState(master?.recurrence);
  const originalKey =
    occurrence?.instanceStart ?? existingEvent?.recurrenceId ?? undefined;
  const [scope, setScope] = useState(
    originalKey && timing ? NativeEventScope.This : NativeEventScope.All,
  );
  const makeBasis = (value: NativeEventScope) =>
    initialForm(
      snapshot,
      value,
      occurrence,
      defaultDate,
      regional.timezone,
      settings?.defaultReminderOffsetMinutes,
    );
  const [basis, setBasis] = useState(() => makeBasis(scope));
  const [form, setForm] = useState(basis);
  const [command, setCommand] = useState<Command | null>(
    intent === "delete" ? "delete" : null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(basis);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const external = existingEvent?.origin === CalendarEventOrigin.External;
  const unsupported = Boolean(timing?.unsupportedReason);
  const canWrite = canManage && !external && !unsupported;
  const ended = timing?.lifecycle === RecurrenceLifecycle.Ended;
  const editRule =
    canWrite &&
    !timing?.readOnly &&
    !ended &&
    (!timing || scope !== NativeEventScope.This);
  const change = (patch: Partial<Form>) =>
    setForm((value) => ({ ...value, ...patch }));
  const wireStart =
    scope !== NativeEventScope.All
      ? (occurrence?.startsAt ?? existingEvent?.startsAt)
      : master?.startsAt;
  const wireEnd =
    scope !== NativeEventScope.All
      ? (occurrence?.endsAt ?? existingEvent?.endsAt)
      : master?.endsAt;
  const sameKind = form.allDay === basis.allDay;
  const sameStart = sameKind && form.startsAt === basis.startsAt;
  const sameEnd = sameKind && form.endsAt === basis.endsAt;
  const startCivil =
    sameStart && !form.allDay
      ? preciseCivil(form.startsAt, wireStart)
      : form.startsAt;
  const endCivil =
    sameEnd && !form.allDay ? preciseCivil(form.endsAt, wireEnd) : form.endsAt;
  const sameZone = form.rule.zone === basis.rule.zone;
  const effectiveDraft = {
    ...form.rule,
    mode: RecurrenceMode.Fixed,
    start: startCivil,
    dateOnly: form.allDay,
  };
  const rule = form.repeat ? recurrenceRule(effectiveDraft) : null;
  const identity =
    server && account
      ? JSON.stringify([server.id, server.baseUrl, account.id, workspace.id])
      : null;
  const clock = useSWR(
    canWrite && identity && !form.allDay && form.startsAt && form.endsAt
      ? ([
          "calendar-civil-clock",
          identity,
          startCivil,
          endCivil,
          form.rule.zone,
          sameStart && sameZone ? wireStart : null,
          sameEnd && sameZone ? wireEnd : null,
        ] as const)
      : null,
    ([, , start, end, zone, savedStart, savedEnd]) =>
      Promise.all([
        savedStart ?? calendar.resolveWallTime(start, zone),
        savedEnd ?? calendar.resolveWallTime(end, zone),
      ]),
    {
      suspense: false,
      keepPreviousData: false,
      shouldRetryOnError: false,
      revalidateOnFocus: false,
      suppressErrorNotification: true,
    },
  );
  const resolvedTimes = form.allDay
    ? [
        sameStart && wireStart ? wireStart : dateBoundary(form.startsAt),
        sameEnd && wireEnd ? wireEnd : dateBoundary(form.endsAt, true),
      ]
    : !clock.error
      ? clock.data
      : undefined;
  useLiveData(calendar.eventsByDateMap$);
  const conflicts =
    resolvedTimes?.[0] && resolvedTimes[1]
      ? calendar
          .checkConflicts(
            dayjs(resolvedTimes[0]),
            dayjs(resolvedTimes[1]),
            master?.id,
          )
          .filter((event) => event.id !== existingEvent?.id)
      : [];
  const preview = useRecurrencePreview(
    server,
    identity,
    workspace.id,
    form.repeat && editRule ? rule : null,
  );
  const reminderOptions = [
    {
      value: "",
      label: t["com.myoxus.integration.calendar.event-dialog.reminder.none"](),
    },
    {
      value: "0",
      label:
        t["com.myoxus.integration.calendar.event-dialog.reminder.at-start"](),
    },
    { value: "5", label: t["com.myoxus.common.reminder.before.5min"]() },
    { value: "15", label: t["com.myoxus.common.reminder.before.15min"]() },
    { value: "30", label: t["com.myoxus.common.reminder.before.30min"]() },
    { value: "60", label: t["com.myoxus.common.reminder.before.1h"]() },
    { value: "1440", label: t["com.myoxus.common.reminder.before.1d"]() },
  ];
  if (
    form.reminderMinutes !== "" &&
    !reminderOptions.some(
      (option) => option.value === String(form.reminderMinutes),
    )
  ) {
    reminderOptions.push({
      value: String(form.reminderMinutes),
      label: t["com.myoxus.common.reminder.before-duration"]({
        duration: new Intl.NumberFormat(t.language, {
          style: "unit",
          unit: "minute",
          unitDisplay: "long",
        }).format(form.reminderMinutes),
      }),
    });
  }
  const refreshNotice = () => {
    if (calendar.refreshFailed$.value)
      notify({ title: t["com.myoxus.integration.calendar.saved-refresh"]() });
  };
  const switchScope = (value: NativeEventScope) => {
    const next = makeBasis(value);
    setScope(value);
    setBasis(next);
    setForm(next);
    setCommand(intent === "delete" ? "delete" : null);
    setSubmitError(null);
  };
  const fail = () =>
    setSubmitError(
      t["com.myoxus.integration.calendar.event-dialog.draft-failed"](),
    );
  const control = async (action: CalendarTimingAction) => {
    if (!master || !timing || pending || !canWrite || dirty) return;
    setPending(true);
    setSubmitError(null);
    try {
      const result = await calendar.controlRecurrence(
        master.id,
        timing.revision,
        action,
      );
      setTiming(result.recurrence);
      refreshNotice();
      if (action === CalendarTimingAction.End) close(master.id);
    } catch {
      fail();
    } finally {
      setPending(false);
    }
  };
  const confirm = async () => {
    if (!command || pending) return;
    if (typeof command === "object") {
      switchScope(command.scope);
      return;
    }
    if (command === "end") {
      await control(CalendarTimingAction.End);
      return;
    }
    if (!master || !canWrite || dirty) return;
    setPending(true);
    setSubmitError(null);
    try {
      await calendar.deleteEvent(
        master.id,
        command === "skip" ? NativeEventScope.This : scope,
        originalKey,
      );
      refreshNotice();
      close(master.id);
    } catch {
      fail();
    } finally {
      setPending(false);
    }
  };
  const submit = async () => {
    if (!canWrite || pending) return;
    if (!form.title.trim()) {
      setSubmitError(
        t["com.myoxus.integration.calendar.event-dialog.missing-title"](),
      );
      return;
    }
    if (!form.startsAt || !form.endsAt) {
      setSubmitError(
        t["com.myoxus.integration.calendar.event-dialog.missing-date"](),
      );
      return;
    }
    setPending(true);
    setSubmitError(null);
    try {
      const [startsAt, endsAt] = resolvedTimes ?? [];
      if (!startsAt || !endsAt) {
        setSubmitError(
          t["com.myoxus.integration.calendar.event-dialog.time-invalid"](),
        );
        return;
      }
      const reminders =
        form.reminderMinutes === ""
          ? []
          : [
              {
                minutesBefore: form.reminderMinutes,
                channel: form.reminderChannel,
              },
            ];
      const recurrence = editRule && form.repeat ? rule?.fixed : undefined;
      const input = {
        title: form.title.trim(),
        startsAt,
        endsAt,
        allDay: form.allDay,
        allMembers: form.allMembers,
        tagId: form.tagId || null,
        ...(recurrence ? { recurrence } : {}),
      };
      if (eventId && master) {
        await calendar.updateEvent(
          master.id,
          scope,
          {
            ...input,
            ...eventReminderPatch(form, basis),
            ...(form.description !== basis.description
              ? {
                  descriptionDelta: form.description
                    ? { text: form.description }
                    : null,
                }
              : {}),
          },
          originalKey,
        );
        refreshNotice();
        close(eventId);
      } else {
        const created = await calendar.createEvent({
          ...input,
          descriptionDelta: form.description
            ? { text: form.description }
            : null,
          reminders,
          sourceExternalId: sourceDocId || undefined,
        });
        refreshNotice();
        close(created.id);
      }
    } catch {
      fail();
    } finally {
      setPending(false);
    }
  };
  const disabled = pending || !canWrite;
  const confirmation =
    command === "skip"
      ? t["com.myoxus.integration.calendar.event-dialog.skip-confirm"]()
      : command === "end"
        ? t["com.myoxus.integration.calendar.event-dialog.end-confirm"]()
        : typeof command === "object"
          ? t[
              "com.myoxus.integration.calendar.event-dialog.scope-change-confirm"
            ]()
          : scope === NativeEventScope.This
            ? t[
                "com.myoxus.integration.calendar.event-dialog.delete-this-confirm"
              ]()
            : scope === NativeEventScope.ThisAndFuture
              ? t[
                  "com.myoxus.integration.calendar.event-dialog.delete-future-confirm"
                ]()
              : t[
                  "com.myoxus.integration.calendar.event-dialog.delete-all-confirm"
                ]();
  return (
    <Stack
      data-testid="event-edit-dialog"
      data-myoxus-ui-role="calendar-event-edit-form"
    >
      {external || unsupported || !canManage ? (
        <SettingsNotice tone="warning">
          {external
            ? t[
                "com.myoxus.integration.calendar.event-dialog.external-readonly"
              ]()
            : unsupported
              ? t[
                  "com.myoxus.integration.calendar.event-dialog.rule-unsupported"
                ]()
              : t["com.myoxus.no-permission"]()}
        </SettingsNotice>
      ) : null}
      {timing ? (
        <FormSelect
          label={t["com.myoxus.integration.calendar.event-dialog.edit-scope"]()}
          allowDeselect={false}
          disabled={pending}
          value={scope}
          data={[
            ...(originalKey
              ? [
                  {
                    value: NativeEventScope.This,
                    label:
                      t[
                        "com.myoxus.integration.calendar.event-dialog.scope.this"
                      ](),
                  },
                  {
                    value: NativeEventScope.ThisAndFuture,
                    label:
                      t[
                        "com.myoxus.integration.calendar.event-dialog.scope.future"
                      ](),
                  },
                ]
              : []),
            {
              value: NativeEventScope.All,
              label:
                t["com.myoxus.integration.calendar.event-dialog.scope.all"](),
            },
          ]}
          onChange={(value) => {
            const next = value as NativeEventScope;
            if (next === scope) return;
            if (dirty) setCommand({ scope: next });
            else switchScope(next);
          }}
        />
      ) : null}
      {command ? (
        <SettingsNotice tone="warning" role="alert">
          {confirmation}
        </SettingsNotice>
      ) : (
        <>
          <Input
            value={form.title}
            onChange={(title) => change({ title })}
            label={t["com.myoxus.integration.calendar.event-dialog.title"]()}
            placeholder={t[
              "com.myoxus.integration.calendar.event-dialog.title-placeholder"
            ]()}
            autoFocus
            disabled={disabled}
            data-testid="event-title-input"
          />
          <Checkbox
            checked={form.allDay}
            disabled={disabled}
            label={t["com.myoxus.integration.calendar.all-day"]()}
            onChange={(_event, allDay) =>
              change({
                allDay,
                startsAt:
                  !allDay && form.startsAt.length === 10
                    ? `${form.startsAt}T09:00:00`
                    : form.startsAt,
                endsAt:
                  !allDay && form.endsAt.length === 10
                    ? `${form.endsAt}T10:00:00`
                    : form.endsAt,
                rule: {
                  ...form.rule,
                  end: form.rule.end
                    ? allDay
                      ? form.rule.end.slice(0, 10)
                      : `${form.rule.end.slice(0, 10)}T${form.startsAt.slice(11) || "09:00:00"}`
                    : "",
                },
              })
            }
          />
          <ResponsiveGrid
            cols={{ base: 1, sm: 2 }}
            data-myoxus-ui-role="calendar-event-edit-time-grid"
          >
            {form.allDay ? (
              <LocalizedDateInput
                value={form.startsAt.slice(0, 10)}
                locale={t.language}
                label={t[
                  "com.myoxus.integration.calendar.event-dialog.start"
                ]()}
                disabled={disabled}
                data-testid="event-start-date-input"
                onChange={(value) => {
                  if (value) change({ startsAt: value });
                }}
              />
            ) : (
              <LocalizedDateTimeInput
                value={form.startsAt}
                locale={t.language}
                label={t[
                  "com.myoxus.integration.calendar.event-dialog.start"
                ]()}
                disabled={disabled}
                data-testid="event-start-datetime-input"
                onChange={(value) => {
                  if (typeof value === "string" && value)
                    change({ startsAt: value });
                }}
              />
            )}
            {form.allDay ? (
              <LocalizedDateInput
                value={form.endsAt.slice(0, 10)}
                locale={t.language}
                label={t["com.myoxus.integration.calendar.event-dialog.end"]()}
                disabled={disabled}
                data-testid="event-end-date-input"
                onChange={(value) => {
                  if (value) change({ endsAt: value });
                }}
              />
            ) : (
              <LocalizedDateTimeInput
                value={form.endsAt}
                locale={t.language}
                label={t["com.myoxus.integration.calendar.event-dialog.end"]()}
                disabled={disabled}
                data-testid="event-end-datetime-input"
                onChange={(value) => {
                  if (typeof value === "string" && value)
                    change({ endsAt: value });
                }}
              />
            )}
          </ResponsiveGrid>
          {!form.repeat || timing?.readOnly ? (
            <MyoxusText tone="secondary">
              {t["com.myoxus.common.timezone"]()}: {form.rule.zone}
            </MyoxusText>
          ) : null}
          {clock.error ? (
            <SettingsNotice tone="error" role="alert">
              <Stack>
                <MyoxusText>
                  {t["com.myoxus.recurrence.preview-failed"]()}
                </MyoxusText>
                <Button onClick={() => void clock.mutate()}>{t.Retry()}</Button>
              </Stack>
            </SettingsNotice>
          ) : resolvedTimes?.some((value) => !value) ? (
            <SettingsNotice tone="warning">
              {t["com.myoxus.integration.calendar.event-dialog.time-invalid"]()}
            </SettingsNotice>
          ) : null}
          {conflicts.length ? (
            <SettingsNotice tone="warning">
              {t[
                "com.myoxus.integration.calendar.event-dialog.overlaps-with"
              ]()}{" "}
              {conflicts
                .map(
                  (event) =>
                    event.title ??
                    t["com.myoxus.integration.calendar.untitled-event"](),
                )
                .join(", ")}
            </SettingsNotice>
          ) : null}
          <Switch
            checked={form.repeat}
            disabled={disabled || Boolean(timing)}
            onChange={(repeat) => change({ repeat })}
          >
            {t["com.myoxus.recurrence.repeat"]()}
          </Switch>
          {form.repeat ? (
            timing?.readOnly ? (
              <Stack>
                <SettingsNotice tone="info">
                  {t[
                    "com.myoxus.integration.calendar.event-dialog.rule-readonly"
                  ]()}
                </SettingsNotice>
                <Textarea
                  label={t[
                    "com.myoxus.integration.calendar.event-dialog.rule-source"
                  ]()}
                  value={timing.sourceRrule ?? ""}
                  readOnly
                />
                <MyoxusText tone="secondary">
                  {t[
                    "com.myoxus.integration.calendar.event-dialog.preview-imported"
                  ]()}
                </MyoxusText>
              </Stack>
            ) : (
              <>
                {!editRule && !ended && canWrite ? (
                  <SettingsNotice tone="info">
                    {t[
                      "com.myoxus.integration.calendar.event-dialog.rule-scope"
                    ]()}
                  </SettingsNotice>
                ) : null}
                <RecurrenceRuleFields
                  value={effectiveDraft}
                  onChange={(draft) => change({ rule: draft })}
                  disabled={pending || !editRule}
                  allowCompletion={false}
                  boundStart
                />
                {editRule ? (
                  <RecurrencePreview result={preview} conditional={false} />
                ) : null}
              </>
            )
          ) : null}
          <FormSelect
            data={reminderOptions}
            label={t["com.myoxus.integration.calendar.event-dialog.reminder"]()}
            disabled={disabled}
            value={String(form.reminderMinutes)}
            onChange={(value) =>
              change({ reminderMinutes: value === "" ? "" : Number(value) })
            }
          />
          {form.reminderMinutes !== "" ? (
            <Checkbox
              checked={form.reminderChannel === "email"}
              disabled={disabled}
              label={t["com.myoxus.share-menu.invite-editor.sent-email"]()}
              onChange={(event) =>
                change({
                  reminderChannel: event.currentTarget.checked
                    ? "email"
                    : "in_app",
                })
              }
            />
          ) : null}
          {tags.length ? (
            <FormSelect
              data={[
                {
                  label:
                    t["com.myoxus.integration.calendar.event-dialog.no-tag"](),
                  value: "",
                },
                ...tags.map((tag) => ({ label: tag.name, value: tag.id })),
              ]}
              label={t["com.myoxus.integration.calendar.event-dialog.tag"]()}
              disabled={disabled}
              value={form.tagId}
              onChange={(tagId) => change({ tagId })}
            />
          ) : null}
          <Checkbox
            checked={form.allMembers}
            disabled={disabled}
            label={t[
              "com.myoxus.integration.calendar.event-dialog.all-members"
            ]()}
            onChange={(_event, allMembers) => change({ allMembers })}
          />
          <Textarea
            value={form.description}
            onChange={(description) => change({ description })}
            label={t["com.myoxus.common.description"]()}
            placeholder={t[
              "com.myoxus.integration.calendar.event-dialog.description-placeholder"
            ]()}
            disabled={disabled}
            minRows={3}
          />
          {timing && !external ? (
            <Stack>
              <MyoxusText>
                {timing.lifecycle === RecurrenceLifecycle.Active
                  ? t["com.myoxus.recurrence.active"]()
                  : timing.lifecycle === RecurrenceLifecycle.Paused
                    ? t["com.myoxus.recurrence.paused"]()
                    : t["com.myoxus.recurrence.ended"]()}
              </MyoxusText>
              {dirty ? (
                <MyoxusText tone="secondary">
                  {t[
                    "com.myoxus.integration.calendar.event-dialog.unsaved-controls"
                  ]()}
                </MyoxusText>
              ) : null}
              <Group>
                {!ended ? (
                  <Button
                    disabled={disabled || dirty}
                    onClick={() =>
                      void control(
                        timing.lifecycle === RecurrenceLifecycle.Paused
                          ? CalendarTimingAction.Resume
                          : CalendarTimingAction.Pause,
                      )
                    }
                  >
                    {timing.lifecycle === RecurrenceLifecycle.Paused
                      ? t["com.myoxus.recurrence.resume"]()
                      : t["com.myoxus.recurrence.pause"]()}
                  </Button>
                ) : null}
                {!ended && originalKey ? (
                  <Button
                    disabled={disabled || dirty}
                    onClick={() => setCommand("skip")}
                  >
                    {t["com.myoxus.integration.calendar.event-dialog.skip"]()}
                  </Button>
                ) : null}
                {!ended ? (
                  <Button
                    disabled={disabled || dirty}
                    onClick={() => setCommand("end")}
                  >
                    {t["com.myoxus.recurrence.end-series"]()}
                  </Button>
                ) : null}
              </Group>
            </Stack>
          ) : null}
        </>
      )}
      {submitError ? (
        <SettingsNotice
          role="alert"
          tone="error"
          data-testid="event-submit-error"
        >
          {submitError}
        </SettingsNotice>
      ) : null}
      <DialogFooterActions data-myoxus-ui-role="calendar-event-edit-actions">
        <Button
          variant="plain"
          disabled={pending}
          onClick={() =>
            command && !(intent === "delete" && command === "delete")
              ? setCommand(null)
              : close(null)
          }
        >
          {t.Cancel()}
        </Button>
        {command ? (
          <Button
            variant="primary"
            loading={pending}
            disabled={pending || (typeof command !== "object" && !canWrite)}
            onClick={() => void confirm()}
          >
            {t.Confirm()}
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={pending}
            disabled={
              disabled ||
              !resolvedTimes?.[0] ||
              !resolvedTimes[1] ||
              (form.repeat &&
                editRule &&
                (!rule ||
                  preview.isLoading ||
                  Boolean(preview.error) ||
                  !preview.data))
            }
            data-testid="event-submit-button"
            onClick={() => void submit()}
          >
            {eventId ? t.Save() : t.Create()}
          </Button>
        )}
      </DialogFooterActions>
    </Stack>
  );
}
