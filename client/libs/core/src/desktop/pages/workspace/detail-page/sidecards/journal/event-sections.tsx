// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Time-bucketed event sections for the journal sidebar.
 *
 * Event buckets:
 *   - Today          (initially open)
 *   - Tomorrow       (initially collapsed)
 *   - This week      (rest of the current week from day-after-tomorrow → end of week,
 *                     locale-aware via dayjs `endOf('week')`)
 *   - Next week      (full following week, initially collapsed)
 *
 * Conditional bucket:
 *   - Selected date  (only when the calendar selection is none of {today, tomorrow,
 *                     this-week-range, next-week-range})
 *
 * Behaviour:
 *   - Only buckets with events render; a fully empty agenda renders one
 *     shared empty state and one event-creation action.
 *   - An event is claimed by the first matching bucket so locale range
 *     overlap cannot duplicate rows.
 *   - Open/closed state per bucket persists in localStorage.
 *   - The component re-derives `now` every minute so:
 *     a) midnight rollover is handled automatically;
 *     b) imminent events get re-coloured at the correct moments
 *        (≤5min: error/red, ≤30min: warning/yellow, currently running: live).
 *   - Today's events that end before `now` are visually demoted (greyed out)
 *     so the user can see at a glance which items are still relevant.
 */
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { usePageHelper } from "@myoxus/core/editor/virgultum/page-list/utils";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocsService } from "@myoxus/core/modules/doc";
import {
  formatRegionalTime,
  type RegionalFormatPreferences,
} from "@myoxus/core/modules/i18n";
import {
  type CalendarEvent,
  IntegrationService,
} from "@myoxus/core/modules/integration";
import { JournalService } from "@myoxus/core/modules/journal";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { NativeEventScope } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  EditIcon,
  FullDayIcon,
  PeriodIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import track from "@myoxus/track";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  EmptyState,
  Group,
  IconButton,
  Loading,
  MyoxusText,
  notify,
  Stack,
  ThemeIcon,
  Tooltip,
} from "@myoxus/ui-facade";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SectionKey = "today" | "tomorrow" | "week" | "next-week" | "selected";

type Imminence = "none" | "live" | "soon" | "now";
type JournalEventTone = "danger" | "default" | "live" | "warning";

const STORAGE_PREFIX = "myoxus-journal-section-open";
const DEFAULT_OPEN: Record<SectionKey, boolean> = {
  today: true,
  tomorrow: false,
  week: false,
  "next-week": false,
  selected: true,
};

function readOpenState(key: SectionKey): boolean {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}-${key}`);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* ignore */
  }
  return DEFAULT_OPEN[key];
}

function writeOpenState(key: SectionKey, value: boolean): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}-${key}`, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

interface Range {
  start: Dayjs;
  end: Dayjs;
}

interface Ranges {
  today: Range;
  tomorrow: Range;
  /** Day-after-tomorrow → end of this week. May be a 0-day range late in the week; section stays visible regardless. */
  week: Range;
  /** Full next ISO/locale week (Mon–Sun, depending on dayjs locale). */
  nextWeek: Range;
}

function buildRanges(now: Dayjs): Ranges {
  const today = now.startOf("day");
  const tomorrow = today.add(1, "day");
  const dayAfterTomorrow = today.add(2, "day");
  const endOfThisWeek = today.endOf("week");
  const startOfNextWeek = today.add(1, "week").startOf("week");
  const endOfNextWeek = startOfNextWeek.endOf("week");

  // If `dayAfterTomorrow` already crosses into next week, the "this week"
  // range becomes empty — we model that by collapsing both ends to the
  // same anchor so `eventsByDateRange$` returns nothing without crashing.
  const weekStart = dayAfterTomorrow.isAfter(endOfThisWeek, "day")
    ? endOfThisWeek
    : dayAfterTomorrow;

  return {
    today: { start: today, end: today.endOf("day") },
    tomorrow: { start: tomorrow, end: tomorrow.endOf("day") },
    week: { start: weekStart, end: endOfThisWeek },
    nextWeek: { start: startOfNextWeek, end: endOfNextWeek },
  };
}

function isWithinRange(date: Dayjs, range: Range): boolean {
  return (
    (date.isAfter(range.start, "day") || date.isSame(range.start, "day")) &&
    (date.isBefore(range.end, "day") || date.isSame(range.end, "day"))
  );
}

/**
 * Pick a one-line bucket label for the user-selected date. Falls back to a
 * full localised date when the date is far from "now".
 */
function formatSelectedDateLabel(
  date: Dayjs,
  now: Dayjs,
  locale: string,
): string {
  const days = date.startOf("day").diff(now.startOf("day"), "day");
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(days < 0 ? { year: "numeric" } : {}),
  }).format(date.toDate());
}

function formatTime(
  preferences: RegionalFormatPreferences,
  start?: Dayjs,
  end?: Dayjs,
): string {
  if (!start || !end) return "";
  const from = formatRegionalTime(start.toDate(), preferences);
  const to = formatRegionalTime(end.toDate(), preferences);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * Returns the imminence bucket for `event` relative to `now`.
 * - `now`  : starts within ≤5 min (or already started in the last 5 min)
 * - `soon` : starts within (5, 30] min
 * - `live` : already running (started in the past, hasn't ended)
 * - `none` : everything else, including all-day events
 */
function classifyImminence(event: CalendarEvent, now: Dayjs): Imminence {
  if (event.allDay) return "none";
  const minutesUntilStart = event.startAt.diff(now, "minute");
  const isRunning = event.startAt.isBefore(now) && event.endAt.isAfter(now);
  if (isRunning && minutesUntilStart > -5) return "now";
  if (isRunning) return "live";
  if (minutesUntilStart >= 0 && minutesUntilStart <= 5) return "now";
  if (minutesUntilStart > 5 && minutesUntilStart <= 30) return "soon";
  return "none";
}

function journalEventToneForImminence(imminence: Imminence): JournalEventTone {
  if (imminence === "now") return "danger";
  if (imminence === "soon") return "warning";
  if (imminence === "live") return "live";
  return "default";
}

function journalEventMantineColor(tone: JournalEventTone) {
  if (tone === "danger") return "myoxusError";
  if (tone === "warning") return "myoxusWarning";
  if (tone === "live") return "myoxusSuccess";
  return "myoxusInfo";
}

function badgeToneForImminence(
  imminence: Imminence,
): "error" | "info" | "neutral" | "warning" {
  if (imminence === "now") return "error";
  if (imminence === "soon") return "warning";
  if (imminence === "live") return "info";
  return "neutral";
}

/**
 * Stable ranges + 1-minute "now" tick that drives midnight rollover and
 * imminent-event recoloring without re-rendering the whole panel.
 */
function useNowTick(): Dayjs {
  const [now, setNow] = useState(() => dayjs());
  useEffect(() => {
    const tick = () => setNow(dayjs());
    // Schedule the first tick on the next minute boundary so updates align
    // with HH:MM and not with the mount time. Subsequent ticks run every 60s.
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}

export type CalendarView = "month" | "week" | "day";

interface EventSectionsProps {
  /**
   * The currently selected calendar date (from the parent panel). When this
   * is not in {today, tomorrow, this-week, next-week} a dedicated
   * "selected date" section is rendered at the top so the user always has
   * an anchor for their click-target.
   */
  selectedDate?: Dayjs;
  /**
   * Calendar view mode driving section visibility:
   * - 'month': all sections (today, tomorrow, week, next-week, selected-when-off-range)
   * - 'week':  today + tomorrow + week (week auto-expanded). Hides next-week + selected.
   * - 'day':   only the selected day's events (auto-expanded). Hides everything else.
   *
   * Defaults to 'month' so existing call sites are unaffected.
   */
  view?: CalendarView;
  readonly?: boolean;
}

export function claimUniqueEventBuckets<T extends { id: string }>(
  buckets: readonly (readonly T[])[],
): T[][] {
  const claimed = new Set<string>();
  return buckets.map((events) =>
    events.filter((event) => {
      if (claimed.has(event.id)) return false;
      claimed.add(event.id);
      return true;
    }),
  );
}

export const EventSections = ({
  selectedDate,
  view = "month",
  readonly = false,
}: EventSectionsProps) => {
  const calendar = useService(IntegrationService).calendar;
  const t = useI18n();
  const now = useNowTick();

  const ranges = useMemo(() => buildRanges(now), [now]);

  // In 'day' view we render a single bucket for the selected day. In 'week'
  // view we drop the selected/next-week sections entirely so the layout
  // collapses to just the current week. In 'month' view we keep everything.
  const showSelected =
    view === "month" &&
    !!selectedDate &&
    !isWithinRange(selectedDate, ranges.today) &&
    !isWithinRange(selectedDate, ranges.tomorrow) &&
    !isWithinRange(selectedDate, ranges.week) &&
    !isWithinRange(selectedDate, ranges.nextWeek);

  const todayEvents = useLiveData(
    useMemo(
      () => calendar.eventsByDateRange$(ranges.today.start, ranges.today.end),
      [calendar, ranges.today.start, ranges.today.end],
    ),
  );
  const tomorrowEvents = useLiveData(
    useMemo(
      () =>
        calendar.eventsByDateRange$(ranges.tomorrow.start, ranges.tomorrow.end),
      [calendar, ranges.tomorrow.start, ranges.tomorrow.end],
    ),
  );
  const weekEvents = useLiveData(
    useMemo(
      () => calendar.eventsByDateRange$(ranges.week.start, ranges.week.end),
      [calendar, ranges.week.start, ranges.week.end],
    ),
  );
  const nextWeekEvents = useLiveData(
    useMemo(
      () =>
        calendar.eventsByDateRange$(ranges.nextWeek.start, ranges.nextWeek.end),
      [calendar, ranges.nextWeek.start, ranges.nextWeek.end],
    ),
  );
  const selectedDateKey =
    selectedDate?.format("YYYY-MM-DD") ??
    ranges.today.start.format("YYYY-MM-DD");
  const selectedRange = useMemo(() => {
    const date = dayjs(selectedDateKey);
    return {
      start: date.startOf("day"),
      end: date.endOf("day"),
    };
  }, [selectedDateKey]);
  const selectedEvents = useLiveData(
    useMemo(
      () => calendar.eventsByDateRange$(selectedRange.start, selectedRange.end),
      [calendar, selectedRange.end, selectedRange.start],
    ),
  );
  const [
    ownedSelectedEvents,
    ownedTodayEvents,
    ownedTomorrowEvents,
    ownedWeekEvents,
    ownedNextWeekEvents,
  ] = useMemo(
    () =>
      claimUniqueEventBuckets([
        showSelected ? selectedEvents : [],
        todayEvents,
        tomorrowEvents,
        weekEvents,
        nextWeekEvents,
      ]),
    [
      nextWeekEvents,
      selectedEvents,
      showSelected,
      todayEvents,
      tomorrowEvents,
      weekEvents,
    ],
  );

  const selectedLabel = selectedDate
    ? formatSelectedDateLabel(selectedDate, now, t.language)
    : "";

  const emptyAgenda = (date: Dayjs) => (
    <AgendaEmptyState defaultDate={date} readonly={readonly} />
  );

  // Day view: single bucket for the selected day. The bucket title is
  // "Heute" if the selection is today, otherwise the formatted day label.
  if (view === "day") {
    const isToday = !!selectedDate && selectedDate.isSame(now, "day");
    const dayTitle = isToday
      ? t["com.myoxus.integration.calendar.section.today"]()
      : selectedLabel;
    const dayEvents = isToday ? todayEvents : selectedEvents;
    const dayAnchor = selectedRange.start;
    return (
      <Stack gap={0} data-testid="event-sections" data-view="day">
        {dayEvents.length === 0 ? (
          emptyAgenda(dayAnchor)
        ) : (
          <Section
            sectionKey={isToday ? "today" : "selected"}
            title={dayTitle}
            events={dayEvents}
            defaultDate={dayAnchor}
            now={now}
            forceOpen
            readonly={readonly}
          />
        )}
      </Stack>
    );
  }

  // Week view: focus on the current week, hide next-week + selected.
  if (view === "week") {
    const hasEvents =
      ownedTodayEvents.length +
        ownedTomorrowEvents.length +
        ownedWeekEvents.length >
      0;
    return (
      <Stack gap={0} data-testid="event-sections" data-view="week">
        {!hasEvents ? emptyAgenda(selectedRange.start) : null}
        {ownedTodayEvents.length > 0 ? (
          <Section
            sectionKey="today"
            title={t["com.myoxus.integration.calendar.section.today"]()}
            events={ownedTodayEvents}
            defaultDate={ranges.today.start}
            now={now}
            readonly={readonly}
          />
        ) : null}
        {ownedTomorrowEvents.length > 0 ? (
          <Section
            sectionKey="tomorrow"
            title={t["com.myoxus.integration.calendar.section.tomorrow"]()}
            events={ownedTomorrowEvents}
            defaultDate={ranges.tomorrow.start}
            now={now}
            readonly={readonly}
          />
        ) : null}
        {ownedWeekEvents.length > 0 ? (
          <Section
            sectionKey="week"
            title={t["com.myoxus.integration.calendar.section.this-week"]()}
            events={ownedWeekEvents}
            defaultDate={ranges.week.start}
            now={now}
            showDayPrefix
            forceOpen
            readonly={readonly}
          />
        ) : null}
      </Stack>
    );
  }

  // Month view (default): all sections.
  const hasMonthEvents =
    ownedSelectedEvents.length +
      ownedTodayEvents.length +
      ownedTomorrowEvents.length +
      ownedWeekEvents.length +
      ownedNextWeekEvents.length >
    0;
  return (
    <Stack gap={0} data-testid="event-sections" data-view="month">
      {!hasMonthEvents ? emptyAgenda(selectedRange.start) : null}
      {ownedSelectedEvents.length > 0 ? (
        <Section
          sectionKey="selected"
          title={selectedLabel}
          events={ownedSelectedEvents}
          defaultDate={selectedRange.start}
          now={now}
          readonly={readonly}
        />
      ) : null}
      {ownedTodayEvents.length > 0 ? (
        <Section
          sectionKey="today"
          title={t["com.myoxus.integration.calendar.section.today"]()}
          events={ownedTodayEvents}
          defaultDate={ranges.today.start}
          now={now}
          readonly={readonly}
        />
      ) : null}
      {ownedTomorrowEvents.length > 0 ? (
        <Section
          sectionKey="tomorrow"
          title={t["com.myoxus.integration.calendar.section.tomorrow"]()}
          events={ownedTomorrowEvents}
          defaultDate={ranges.tomorrow.start}
          now={now}
          readonly={readonly}
        />
      ) : null}
      {ownedWeekEvents.length > 0 ? (
        <Section
          sectionKey="week"
          title={t["com.myoxus.integration.calendar.section.this-week"]()}
          events={ownedWeekEvents}
          defaultDate={ranges.week.start}
          now={now}
          showDayPrefix
          readonly={readonly}
        />
      ) : null}
      {ownedNextWeekEvents.length > 0 ? (
        <Section
          sectionKey="next-week"
          title={t["com.myoxus.integration.calendar.section.next-week"]()}
          events={ownedNextWeekEvents}
          defaultDate={ranges.nextWeek.start}
          now={now}
          showDayPrefix
          readonly={readonly}
        />
      ) : null}
    </Stack>
  );
};

function AgendaEmptyState({
  defaultDate,
  readonly,
}: {
  defaultDate: Dayjs;
  readonly: boolean;
}) {
  const t = useI18n();
  const journalService = useService(JournalService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const handleAdd = useCallback(() => {
    const date = defaultDate.format("YYYY-MM-DD");
    const journalDoc = journalService.getJournalsByDate(date)[0];
    workspaceDialogService.open("event-edit", {
      defaultDate: date,
      sourceDocId: journalDoc?.id,
    });
  }, [defaultDate, journalService, workspaceDialogService]);

  return (
    <EmptyState
      title={t["com.myoxus.integration.calendar.section.empty"]()}
      cta={
        readonly ? null : (
          <Button
            data-testid="journal-agenda-empty-add"
            onClick={handleAdd}
            prefix={<PlusIcon />}
            variant="primary"
          >
            {t["com.myoxus.integration.calendar.add-event"]()}
          </Button>
        )
      }
      data-testid="journal-agenda-empty"
    />
  );
}

const Section = ({
  sectionKey,
  title,
  events,
  defaultDate,
  showDayPrefix,
  now,
  forceOpen,
  readonly,
}: {
  sectionKey: SectionKey;
  title: string;
  events: CalendarEvent[];
  defaultDate: Dayjs;
  showDayPrefix?: boolean;
  now: Dayjs;
  /**
   * When true, the section ignores the persisted open/closed flag and stays
   * expanded (and the toggle button is hidden). Used in week/day views where
   * collapsing the focused section would defeat the view's purpose.
   */
  forceOpen?: boolean;
  readonly: boolean;
}) => {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);
  const journalService = useService(JournalService);
  const [storedOpen, setStoredOpen] = useState(() => readOpenState(sectionKey));
  const open = forceOpen ? true : storedOpen;

  const handleAccordionChange = useCallback(
    (nextValue: string | string[] | null) => {
      if (forceOpen) return;
      const values = Array.isArray(nextValue)
        ? nextValue
        : nextValue
          ? [nextValue]
          : [];
      const nextOpen = values.includes(sectionKey);
      setStoredOpen(nextOpen);
      writeOpenState(sectionKey, nextOpen);
    },
    [forceOpen, sectionKey],
  );

  const handleAdd = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();
      const dateStr = defaultDate.format("YYYY-MM-DD");
      const journalDoc = journalService.getJournalsByDate(dateStr)[0];
      workspaceDialogService.open("event-edit", {
        defaultDate: dateStr,
        sourceDocId: journalDoc?.id,
      });
      // Auto-open the section if it was collapsed so the new entry becomes
      // visible. Skip when forceOpen — already expanded.
      if (!open && !forceOpen) {
        setStoredOpen(true);
        writeOpenState(sectionKey, true);
      }
    },
    [
      defaultDate,
      forceOpen,
      journalService,
      open,
      sectionKey,
      workspaceDialogService,
    ],
  );

  return (
    <Accordion
      multiple
      value={open ? [sectionKey] : []}
      onChange={handleAccordionChange}
      data-myoxus-ui-role="journal-section"
      data-testid={`event-section-${sectionKey}`}
    >
      <AccordionItem
        value={sectionKey}
        data-myoxus-ui-role="journal-section-item"
      >
        <AccordionControl
          disabled={forceOpen}
          chevron={forceOpen ? null : undefined}
          data-force-open={forceOpen ? "true" : undefined}
          data-myoxus-ui-role="button:journal-section-header"
          data-testid={`event-section-header-${sectionKey}`}
        >
          <Group wrap="nowrap" data-myoxus-ui-role="journal-section-label">
            <MyoxusText
              typographySlot="nav"
              data-myoxus-ui-role="journal-section-title"
            >
              {title}
            </MyoxusText>
            <Badge
              aria-label={t["com.myoxus.integration.calendar.section.count"]({
                count: String(events.length),
              })}
              data-myoxus-ui-role="badge:journal-section-count"
            >
              {events.length}
            </Badge>
          </Group>
        </AccordionControl>
        <AccordionPanel data-myoxus-ui-role="journal-section-content">
          <Stack>
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                showDayPrefix={showDayPrefix}
                now={now}
                readonly={readonly}
              />
            ))}
            {!readonly ? (
              <Group data-myoxus-ui-role="journal-section-actions">
                <Button
                  data-myoxus-ui-role="button:compact:journal-section-add"
                  data-testid={`event-section-add-${sectionKey}`}
                  onClick={handleAdd}
                  prefix={<PlusIcon />}
                  title={t["com.myoxus.integration.calendar.add-event"]()}
                  variant="plain"
                >
                  {t["com.myoxus.integration.calendar.add-event"]()}
                </Button>
              </Group>
            ) : null}
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};

const EventRow = ({
  event,
  showDayPrefix,
  now,
  readonly,
}: {
  event: CalendarEvent;
  showDayPrefix?: boolean;
  now: Dayjs;
  readonly: boolean;
}) => {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const { startAt, endAt, allDay, calendarName, calendarColor } = event;
  const [loading, setLoading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const docsService = useService(DocsService);
  const guardService = useService(GuardService);
  const journalService = useService(JournalService);
  const workspaceService = useService(WorkspaceService);
  const workspaceDialogService = useService(WorkspaceDialogService);
  const calendar = useService(IntegrationService).calendar;
  const { createPage } = usePageHelper(
    workspaceService.workspace.docCollection,
  );
  const calLabel =
    calendarName || t["com.myoxus.integration.calendar.untitled-event"]();
  const color = calendarColor || cssVar("primaryColor");
  const eventTitle =
    event.title || t["com.myoxus.integration.calendar.untitled-event"]();
  const dateStr = event.date.format("YYYY-MM-DD");

  const imminence = useMemo(() => classifyImminence(event, now), [event, now]);
  const minutesUntilStart = useMemo(
    () => event.startAt.diff(now, "minute"),
    [event.startAt, now],
  );

  const handleCreateDoc = useAsyncCallback(async () => {
    if (loading) return;
    const docs = journalService.getJournalsByDate(dateStr);
    if (docs.length === 0) {
      notify({
        title: t["com.myoxus.integration.calendar.no-journal"]({
          date: dateStr,
        }),
      });
      return;
    }

    setLoading(true);
    try {
      for (const doc of docs) {
        const canEdit = await guardService.can("Doc_Update", doc.id);
        if (!canEdit) {
          notify({ title: t["com.myoxus.no-permission"]() });
          continue;
        }
        const newDoc = createPage();
        await docsService.changeDocTitle(newDoc.id, eventTitle);
        await docsService.addLinkedDoc(doc.id, newDoc.id);
      }
      track.doc.sidepanel.journal.createCalendarDocEvent();
    } finally {
      setLoading(false);
    }
  }, [
    createPage,
    dateStr,
    docsService,
    guardService,
    journalService,
    loading,
    t,
    eventTitle,
  ]);

  const handleEdit = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();
      workspaceDialogService.open("event-edit", { eventId: event.id });
    },
    [workspaceDialogService, event.id],
  );

  const handleDeleteRequest = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDelete(true);
  }, []);

  const handleDeleteCancel = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
    setPendingDelete(false);
  }, []);

  const handleDeleteConfirm = useAsyncCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await calendar.deleteEvent(event.id, NativeEventScope.All);
      } catch (err) {
        notify({
          title:
            err instanceof Error
              ? err.message
              : t["com.myoxus.integration.calendar.event-delete-error"](),
        });
      } finally {
        setPendingDelete(false);
      }
    },
    [calendar, event.id, t],
  );

  // Auto-focus the cancel button on entering pendingDelete so users can
  // dismiss the destructive confirm with Enter without first tabbing.
  useEffect(() => {
    if (pendingDelete) {
      cancelDeleteRef.current?.focus();
    }
  }, [pendingDelete]);

  // Esc anywhere on the row dismisses the confirm.
  const handlePendingKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setPendingDelete(false);
    }
  }, []);

  // Row keyboard activation (Enter / Space) — opens the edit dialog.
  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (readonly) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        handleEdit(e);
      }
    },
    [handleEdit, readonly],
  );

  const dayPrefix = showDayPrefix ? event.date.format("dd. ") : null;

  // Build the time caption: day-prefix · time (or all-day) · countdown chip
  const timeText = allDay
    ? t["com.myoxus.integration.calendar.all-day"]()
    : formatTime(regionalPreferences, startAt, endAt);

  const countdownLabel = (() => {
    if (imminence === "now") {
      return minutesUntilStart >= 0
        ? t["com.myoxus.integration.calendar.starting-in-minutes"]({
            count: String(Math.max(minutesUntilStart, 0)),
          })
        : t["com.myoxus.integration.calendar.live-now"]();
    }
    if (imminence === "soon") {
      return t["com.myoxus.integration.calendar.starting-in-minutes"]({
        count: String(minutesUntilStart),
      });
    }
    if (imminence === "live") {
      return t["com.myoxus.integration.calendar.live-now"]();
    }
    return null;
  })();
  const rowTone = journalEventToneForImminence(imminence);

  if (pendingDelete) {
    return (
      <Group
        align="center"
        wrap="nowrap"
        data-myoxus-ui-role="event-row"
        data-testid="event-row"
        data-pending-delete="true"
        onKeyDown={handlePendingKeyDown}
      >
        <ThemeIcon
          color="myoxusError"
          variant="light"
          data-myoxus-ui-role="event-row-icon"
        >
          {allDay ? <FullDayIcon /> : <PeriodIcon />}
        </ThemeIcon>
        <Stack data-myoxus-ui-role="event-row-body">
          <MyoxusText
            typographySlot="body-small"
            data-myoxus-ui-role="event-row-title"
          >
            {eventTitle}
          </MyoxusText>
          <MyoxusText
            typographySlot="label-compact"
            tone="secondary"
            data-myoxus-ui-role="event-row-caption"
          >
            {t["com.myoxus.integration.calendar.event-delete-prompt"]()}
          </MyoxusText>
        </Stack>
        <Group
          justify="flex-end"
          wrap="nowrap"
          data-myoxus-ui-role="event-row-actions"
        >
          <Button
            type="button"
            data-myoxus-ui-role="button:compact"
            data-testid="event-delete-confirm"
            onClick={handleDeleteConfirm}
            variant="error"
          >
            {t["com.myoxus.integration.calendar.event-delete-confirm"]()}
          </Button>
          <Button
            ref={cancelDeleteRef}
            type="button"
            data-myoxus-ui-role="button:compact"
            data-testid="event-delete-cancel"
            onClick={handleDeleteCancel}
            variant="plain"
          >
            {t["com.myoxus.integration.calendar.event-delete-cancel"]()}
          </Button>
        </Group>
      </Group>
    );
  }

  return (
    <Group
      align="center"
      role={readonly ? undefined : "button"}
      tabIndex={readonly ? undefined : 0}
      wrap="nowrap"
      data-all-day={allDay}
      data-imminence={imminence}
      data-myoxus-ui-role="event-row"
      data-testid="event-row"
      onClick={readonly ? undefined : handleEdit}
      onKeyDown={readonly ? undefined : handleRowKeyDown}
    >
      <Tooltip
        align="start"
        side="top"
        content={
          <Group
            align="center"
            wrap="nowrap"
            data-myoxus-ui-role="event-row-calendar-tooltip"
          >
            <ThemeIcon
              color={color}
              variant="filled"
              data-myoxus-ui-role="event-row-calendar-swatch"
            />
            <MyoxusText
              typographySlot="body-small"
              data-myoxus-ui-role="event-row-calendar-label"
            >
              {calLabel}
            </MyoxusText>
          </Group>
        }
      >
        <ThemeIcon
          color={journalEventMantineColor(rowTone)}
          variant={rowTone === "default" ? "transparent" : "light"}
          data-myoxus-ui-role="event-row-icon"
        >
          {allDay ? <FullDayIcon /> : <PeriodIcon />}
        </ThemeIcon>
      </Tooltip>
      <Stack data-myoxus-ui-role="event-row-body">
        <MyoxusText
          typographySlot="body-small"
          data-myoxus-ui-role="event-row-title"
        >
          {eventTitle}
        </MyoxusText>
        <MyoxusText
          typographySlot="label-compact"
          tone="secondary"
          data-myoxus-ui-role="event-row-caption"
        >
          <span>
            {dayPrefix}
            {timeText}
          </span>
          {countdownLabel ? (
            <Badge
              tone={badgeToneForImminence(imminence)}
              surface="floating"
              aria-live="polite"
              data-myoxus-ui-role="badge:journal-event-countdown"
            >
              {countdownLabel}
            </Badge>
          ) : null}
        </MyoxusText>
      </Stack>
      {loading ? (
        <Loading />
      ) : !readonly ? (
        <Group
          justify="flex-end"
          wrap="nowrap"
          data-myoxus-ui-role="event-row-actions"
        >
          <IconButton
            type="button"
            title={t["com.myoxus.integration.calendar.event-edit"]()}
            aria-label={t["com.myoxus.integration.calendar.event-edit"]()}
            data-myoxus-ui-role="button:icon-only:journal-event-edit"
            data-testid="event-row-edit"
            icon={<EditIcon />}
            onClick={handleEdit}
          />
          <IconButton
            type="button"
            title={t["com.myoxus.integration.calendar.new-doc"]()}
            aria-label={t["com.myoxus.integration.calendar.new-doc"]()}
            data-myoxus-ui-role="button:icon-only:journal-event-create-doc"
            data-testid="event-row-create-doc"
            icon={<PlusIcon />}
            onClick={(e) => {
              e.stopPropagation();
              handleCreateDoc();
            }}
          />
          <IconButton
            type="button"
            title={t["com.myoxus.integration.calendar.event-delete"]()}
            aria-label={t["com.myoxus.integration.calendar.event-delete"]()}
            data-myoxus-ui-role="button:icon-only:journal-event-delete"
            data-testid="event-row-delete"
            icon={<DeleteIcon />}
            onClick={handleDeleteRequest}
            variant="error"
          />
        </Group>
      ) : null}
    </Group>
  );
};
