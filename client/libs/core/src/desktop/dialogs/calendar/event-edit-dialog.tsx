import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import {
  type CalendarEventQuery,
  type CalendarEventsQuery,
  NativeEventScope,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Checkbox,
  DialogFooterActions,
  FormSelect,
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Modal,
  ResponsiveGrid,
  SettingsNotice,
  Stack,
  Textarea,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback, useEffect, useState } from "react";

import { IntegrationService } from "../../../modules/integration";

// ---- types ------------------------------------------------------------------

type WorkspaceEventDetails = NonNullable<CalendarEventQuery["calendarEvent"]>;
type CachedCalendarEvent = NonNullable<
  CalendarEventsQuery["workspace"]
>["calendars"][number]["events"][number];

// ---- helpers ----------------------------------------------------------------

function toDatetimeLocal(iso: string): string {
  return dayjs(iso).format("YYYY-MM-DDTHH:mm");
}

function fromDatetimeLocal(value: string): string {
  return dayjs(value).toISOString();
}

function defaultStartLocal(date?: string): string {
  const base = date ? dayjs(date) : dayjs();
  return base.startOf("hour").add(1, "hour").format("YYYY-MM-DDTHH:mm");
}

function defaultEndLocal(startLocal: string): string {
  return dayjs(startLocal).add(1, "hour").format("YYYY-MM-DDTHH:mm");
}

function descriptionText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("delta" in value && Array.isArray(value.delta)) {
    return value.delta
      .map((entry) =>
        entry &&
        typeof entry === "object" &&
        "insert" in entry &&
        typeof entry.insert === "string"
          ? entry.insert
          : "",
      )
      .join("");
  }
  return "";
}

// ---- component --------------------------------------------------------------

export const EventEditDialog = ({
  close,
  eventId,
  defaultDate,
  sourceDocId,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["event-edit"]>) => {
  const t = useI18n();
  const integrationService = useService(IntegrationService);
  const tags = useLiveData(integrationService.calendar.tags$);
  const calendarSettings = useLiveData(integrationService.calendar.settings$);
  const reminderOptions = [
    {
      label: t["com.myoxus.integration.calendar.event-dialog.reminder.none"](),
      value: "",
    },
    {
      label:
        t["com.myoxus.integration.calendar.event-dialog.reminder.at-start"](),
      value: "0",
    },
    {
      label: t["com.myoxus.common.reminder.before.5min"](),
      value: "5",
    },
    {
      label: t["com.myoxus.common.reminder.before.15min"](),
      value: "15",
    },
    {
      label: t["com.myoxus.common.reminder.before.30min"](),
      value: "30",
    },
    {
      label: t["com.myoxus.common.reminder.before.1h"](),
      value: "60",
    },
    {
      label: t["com.myoxus.common.reminder.before.1d"](),
      value: "1440",
    },
  ];

  const isEditMode = Boolean(eventId);

  const eventDetailsById = useLiveData(
    integrationService.calendar.eventDetailsById$,
  );
  const existingEvent: WorkspaceEventDetails | null = eventId
    ? (eventDetailsById.get(eventId) ?? null)
    : null;
  const [eventLoadError, setEventLoadError] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(
    Boolean(eventId && !existingEvent),
  );
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!eventId || existingEvent) {
      setLoadingEvent(false);
      setEventLoadError(false);
      return;
    }
    let active = true;
    setLoadingEvent(true);
    setEventLoadError(false);
    void integrationService.calendar
      .resolveEventDetails(eventId)
      .then((event) => {
        if (active && !event) setEventLoadError(true);
      })
      .catch(() => {
        if (active) setEventLoadError(true);
      })
      .finally(() => {
        if (active) setLoadingEvent(false);
      });
    return () => {
      active = false;
    };
  }, [eventId, existingEvent, integrationService, loadAttempt]);

  // ---- form state -----------------------------------------------------------
  const [title, setTitle] = useState(existingEvent?.title ?? "");
  const [startsAt, setStartsAt] = useState(
    existingEvent
      ? toDatetimeLocal(existingEvent.startsAt)
      : defaultStartLocal(defaultDate),
  );
  const [endsAt, setEndsAt] = useState(
    existingEvent
      ? toDatetimeLocal(existingEvent.endsAt)
      : (() => {
          const start = defaultStartLocal(defaultDate);
          return defaultEndLocal(start);
        })(),
  );
  const [allDay, setAllDay] = useState(existingEvent?.allDay ?? false);
  const [allMembers, setAllMembers] = useState(false);
  const [reminderMinutes, setReminderMinutes] = useState<number | "">(
    existingEvent?.reminders[0]?.minutesBefore ??
      calendarSettings?.defaultReminderOffsetMinutes ??
      "",
  );
  // Editing the time must preserve the saved delivery channel.
  const [reminderChannel, setReminderChannel] = useState(
    existingEvent?.reminders[0]?.channel ?? "in_app",
  );
  const [tagId, setTagId] = useState(existingEvent?.tagId ?? "");
  const [description, setDescription] = useState(
    descriptionText(existingEvent?.descriptionDelta),
  );
  const [scope, setScope] = useState<NativeEventScope>(NativeEventScope.All);

  useEffect(() => {
    if (!existingEvent) return;
    setTitle(existingEvent.title ?? "");
    setStartsAt(toDatetimeLocal(existingEvent.startsAt));
    setEndsAt(toDatetimeLocal(existingEvent.endsAt));
    setAllDay(existingEvent.allDay);
    setReminderMinutes(existingEvent.reminders[0]?.minutesBefore ?? "");
    setReminderChannel(existingEvent.reminders[0]?.channel ?? "in_app");
    setTagId(existingEvent.tagId ?? "");
    setDescription(descriptionText(existingEvent.descriptionDelta));
  }, [existingEvent]);

  // ---- conflict check -------------------------------------------------------
  const [conflicts, setConflicts] = useState<CachedCalendarEvent[]>([]);

  const recheckConflicts = useCallback(
    (start: string, end: string) => {
      if (!start || !end) return;
      const startDayjs = dayjs(start);
      const endDayjs = dayjs(end);
      if (!startDayjs.isValid() || !endDayjs.isValid()) return;
      const result = integrationService.calendar.checkConflicts(
        startDayjs,
        endDayjs,
        eventId,
      );
      setConflicts(result);
    },
    [integrationService, eventId],
  );

  useEffect(() => {
    recheckConflicts(startsAt, endsAt);
  }, [startsAt, endsAt, recheckConflicts]);

  // ---- submit ---------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) {
      setSubmitError(
        t["com.myoxus.integration.calendar.event-dialog.missing-title"](),
      );
      return;
    }
    if (!startsAt || !endsAt) {
      setSubmitError(
        t["com.myoxus.integration.calendar.event-dialog.missing-date"](),
      );
      return;
    }

    setSaving(true);
    setSubmitError(null);

    try {
      const reminders =
        reminderMinutes !== ""
          ? [
              {
                minutesBefore: reminderMinutes as number,
                channel: reminderChannel,
              },
            ]
          : undefined;

      if (isEditMode && eventId) {
        await integrationService.calendar.updateEvent(eventId, scope, {
          title: title.trim(),
          startsAt: fromDatetimeLocal(startsAt),
          endsAt: fromDatetimeLocal(endsAt),
          allDay,
          tagId: tagId || null,
          descriptionDelta: description ? { text: description } : undefined,
          reminders: reminderMinutes === "" ? [] : reminders,
        });
        close(eventId);
      } else {
        const created = await integrationService.calendar.createEvent({
          title: title.trim(),
          startsAt: fromDatetimeLocal(startsAt),
          endsAt: fromDatetimeLocal(endsAt),
          allDay,
          allMembers,
          tagId: tagId || undefined,
          reminders,
          sourceExternalId: sourceDocId || undefined,
          descriptionDelta: description ? { text: description } : undefined,
        });
        close(created.id);
      }
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : t["com.myoxus.integration.calendar.event-dialog.save-error"](),
      );
    } finally {
      setSaving(false);
    }
  }, [
    title,
    startsAt,
    endsAt,
    allDay,
    allMembers,
    reminderMinutes,
    reminderChannel,
    tagId,
    description,
    scope,
    isEditMode,
    eventId,
    integrationService,
    sourceDocId,
    close,
    t,
  ]);

  if (isEditMode && (loadingEvent || eventLoadError || !existingEvent)) {
    return (
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) close(null);
        }}
        title={t["com.myoxus.integration.calendar.event-edit"]()}
      >
        <Stack data-testid="event-edit-dialog-load-state">
          <SettingsNotice
            role={eventLoadError ? "alert" : "status"}
            tone={eventLoadError ? "error" : "info"}
          >
            {eventLoadError
              ? t["com.myoxus.editor.event.unavailable"]()
              : t.Loading()}
          </SettingsNotice>
          <DialogFooterActions>
            <Button variant="plain" onClick={() => close(null)}>
              {t["com.myoxus.confirmModal.button.cancel"]()}
            </Button>
            {eventLoadError ? (
              <Button
                variant="secondary"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {t.Retry()}
              </Button>
            ) : null}
          </DialogFooterActions>
        </Stack>
      </Modal>
    );
  }

  // ---- render ---------------------------------------------------------------
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
      title={
        isEditMode
          ? t["com.myoxus.integration.calendar.event-edit"]()
          : t["com.myoxus.integration.calendar.add-event"]()
      }
    >
      <Stack
        data-testid="event-edit-dialog"
        data-myoxus-ui-role="calendar-event-edit-form"
      >
        <Input
          value={title}
          onChange={setTitle}
          label={t["com.myoxus.integration.calendar.event-dialog.title"]()}
          placeholder={t[
            "com.myoxus.integration.calendar.event-dialog.title-placeholder"
          ]()}
          autoFocus
          data-testid="event-title-input"
        />

        <Checkbox
          checked={allDay}
          label={t["com.myoxus.integration.calendar.all-day"]()}
          onChange={(_event, checked) => setAllDay(checked)}
        />

        <ResponsiveGrid
          cols={{ base: 1, sm: 2 }}
          data-myoxus-ui-role="calendar-event-edit-time-grid"
        >
          {allDay ? (
            <LocalizedDateInput
              value={startsAt.slice(0, 10)}
              label={t["com.myoxus.integration.calendar.event-dialog.start"]()}
              locale={t.language}
              data-testid="event-start-date-input"
              onChange={(value) => {
                if (!value) return;
                setStartsAt(`${value}T00:00`);
              }}
            />
          ) : (
            <LocalizedDateTimeInput
              value={startsAt}
              label={t["com.myoxus.integration.calendar.event-dialog.start"]()}
              locale={t.language}
              data-testid="event-start-datetime-input"
              onChange={(value) => {
                if (typeof value !== "string" || !value) return;
                setStartsAt(value);
              }}
            />
          )}
          {allDay ? (
            <LocalizedDateInput
              value={endsAt.slice(0, 10)}
              label={t["com.myoxus.integration.calendar.event-dialog.end"]()}
              locale={t.language}
              data-testid="event-end-date-input"
              onChange={(value) => {
                if (!value) return;
                setEndsAt(`${value}T23:59`);
              }}
            />
          ) : (
            <LocalizedDateTimeInput
              value={endsAt}
              label={t["com.myoxus.integration.calendar.event-dialog.end"]()}
              locale={t.language}
              data-testid="event-end-datetime-input"
              onChange={(value) => {
                if (typeof value !== "string" || !value) return;
                setEndsAt(value);
              }}
            />
          )}
        </ResponsiveGrid>

        {conflicts.length > 0 && (
          <SettingsNotice
            data-myoxus-ui-role="calendar-event-conflict-notice"
            role="alert"
            tone="warning"
          >
            {t["com.myoxus.integration.calendar.event-dialog.overlaps-with"]()}{" "}
            {conflicts
              .map(
                (c) =>
                  c.title ??
                  t["com.myoxus.integration.calendar.untitled-event"](),
              )
              .join(", ")}
          </SettingsNotice>
        )}

        <FormSelect
          data={reminderOptions}
          label={t["com.myoxus.integration.calendar.event-dialog.reminder"]()}
          value={String(reminderMinutes)}
          onChange={(value) =>
            setReminderMinutes(value === "" ? "" : Number(value))
          }
        />

        {reminderMinutes !== "" && (
          <Checkbox
            checked={reminderChannel === "email"}
            label={t["com.myoxus.share-menu.invite-editor.sent-email"]()}
            onChange={(event) =>
              setReminderChannel(
                event.currentTarget.checked ? "email" : "in_app",
              )
            }
          />
        )}

        {tags.length > 0 && (
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
            value={tagId}
            onChange={setTagId}
          />
        )}

        {!isEditMode ? (
          <Checkbox
            checked={allMembers}
            label={t[
              "com.myoxus.integration.calendar.event-dialog.all-members"
            ]()}
            onChange={(_event, checked) => setAllMembers(checked)}
          />
        ) : null}

        <Textarea
          value={description}
          onChange={setDescription}
          placeholder={t[
            "com.myoxus.integration.calendar.event-dialog.description-placeholder"
          ]()}
          label={t[
            "com.myoxus.integration.calendar.event-dialog.description"
          ]()}
          minRows={3}
        />

        {isEditMode && existingEvent?.recurrenceParentId && (
          <FormSelect
            data={[
              {
                label:
                  t[
                    "com.myoxus.integration.calendar.event-dialog.scope.this"
                  ](),
                value: NativeEventScope.This,
              },
              {
                label:
                  t["com.myoxus.integration.calendar.event-dialog.scope.all"](),
                value: NativeEventScope.All,
              },
            ]}
            label={t[
              "com.myoxus.integration.calendar.event-dialog.edit-scope"
            ]()}
            value={scope}
            onChange={(value) => setScope(value as NativeEventScope)}
          />
        )}

        {submitError && (
          <SettingsNotice
            data-myoxus-ui-role="calendar-event-submit-error"
            role="alert"
            tone="error"
          >
            {submitError}
          </SettingsNotice>
        )}

        <DialogFooterActions data-myoxus-ui-role="calendar-event-edit-actions">
          <Button variant="plain" onClick={() => close(null)}>
            {t["com.myoxus.confirmModal.button.cancel"]()}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              handleSubmit().catch(console.error);
            }}
            loading={saving}
            disabled={saving}
            data-testid="event-submit-button"
          >
            {isEditMode ? t.Save() : t.Create()}
          </Button>
        </DialogFooterActions>
      </Stack>
    </Modal>
  );
};
