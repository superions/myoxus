import type {
  CalendarAccountsQuery,
  CalendarTimingAction,
  CalendarEventQuery,
  CalendarEventsQuery,
  CalendarEventTagsQuery,
  CreateEventTagInput,
  CreateWorkspaceEventInput,
  NativeEventScope,
  UpdateEventTagInput,
  UpdateWorkspaceCalendarSettingsInput,
  UpdateWorkspaceEventInput,
  WorkspaceCalendarItemInput,
  WorkspaceCalendarSettingsQuery,
  WorkspaceCalendarsQuery,
} from "@myoxus/graphql";
import { Entity, LiveData } from "@myoxus/infra";
import { CalendarEventOrigin } from "@myoxus/graphql";
import dayjs, { type Dayjs } from "dayjs";

import type { CalendarStore } from "../store/calendar";
import type { CalendarEvent } from "../type";

type CachedCalendarEvent = NonNullable<
  CalendarEventsQuery["workspace"]
>["calendars"][number]["events"][number];

type WorkspaceEventSnapshot = NonNullable<CalendarEventQuery["calendarEvent"]>;

export class CalendarIntegration extends Entity {
  private eventsGeneration = 0;
  private activeRange: { start: Dayjs; end: Dayjs } | null = null;
  readonly refreshFailed$ = new LiveData(false);
  constructor(private readonly store: CalendarStore) {
    super();
  }

  accounts$ = new LiveData<
    NonNullable<
      CalendarAccountsQuery["currentUser"]
    >["calendarAccounts"][number][]
  >([]);
  accountCalendars$ = new LiveData<
    Map<
      string,
      NonNullable<
        NonNullable<
          CalendarAccountsQuery["currentUser"]
        >["calendarAccounts"][number]
      >["calendars"]
    >
  >(new Map());
  workspaceCalendars$ = new LiveData<
    NonNullable<WorkspaceCalendarsQuery["workspace"]>["calendars"][number][]
  >([]);
  readonly eventsByDateMap$ = new LiveData<
    Map<
      string,
      NonNullable<
        CalendarEventsQuery["workspace"]
      >["calendars"][number]["events"][number][]
    >
  >(new Map());
  readonly eventDetailsById$ = new LiveData<
    Map<string, WorkspaceEventSnapshot>
  >(new Map());
  readonly eventDates$ = LiveData.computed((get) => {
    const eventsByDateMap = get(this.eventsByDateMap$);
    const dates = new Set<string>();
    for (const [date, events] of eventsByDateMap) {
      if (events.length > 0) {
        dates.add(date);
      }
    }
    return dates;
  });

  /** Maps dateStr (YYYY-MM-DD) → tag hex color of the first event with a tag, or null if none have tags. */
  readonly eventDateColors$ = LiveData.computed((get) => {
    const eventsByDateMap = get(this.eventsByDateMap$);
    const tags = get(this.tags$);
    const tagColorById = new Map(tags.map((t) => [t.id, t.color]));
    const result = new Map<string, string | null>();
    for (const [date, events] of eventsByDateMap) {
      if (events.length === 0) continue;
      let color: string | null = null;
      for (const event of events) {
        if (event.tagId) {
          color = tagColorById.get(event.tagId) ?? null;
          if (color) break;
        }
      }
      result.set(date, color);
    }
    return result;
  });

  /** Returns the next `limit` events from now, sorted chronologically. */
  upcomingEvents$(limit = 5) {
    return LiveData.computed((get) => {
      const eventsByDateMap = get(this.eventsByDateMap$);
      const now = dayjs();
      const upcoming: NonNullable<
        CalendarEventsQuery["workspace"]
      >["calendars"][number]["events"][number][] = [];
      for (const events of eventsByDateMap.values()) {
        for (const event of events) {
          if (dayjs(event.endAtUtc).isAfter(now)) {
            upcoming.push(event);
          }
        }
      }
      return upcoming
        .sort((a, b) => a.startAtUtc.localeCompare(b.startAtUtc))
        .slice(0, limit);
    });
  }

  tags$ = new LiveData<CalendarEventTagsQuery["calendarEventTags"]>([]);

  settings$ = new LiveData<
    WorkspaceCalendarSettingsQuery["workspaceCalendarSettings"]
  >(null);

  /**
   * Timestamp (epoch ms) of the most recent successful events fetch via
   * `revalidateEventsRange`, or `null` if events have never been loaded since
   * the entity was created. Surfaced in the journal sidebar so the user can
   * see how stale the displayed events are.
   */
  readonly lastRevalidatedAt$ = new LiveData<number | null>(null);

  private readonly subscriptionInfoById$ = LiveData.computed((get) => {
    const accountCalendars = get(this.accountCalendars$);
    const workspaceCalendars = get(this.workspaceCalendars$);
    const subscriptionInfo = new Map<
      string,
      {
        subscription: NonNullable<
          NonNullable<
            CalendarAccountsQuery["currentUser"]
          >["calendarAccounts"][number]
        >["calendars"][number];
        colorOverride?: string | null;
      }
    >();

    for (const calendars of accountCalendars.values()) {
      for (const calendar of calendars) {
        subscriptionInfo.set(calendar.id, { subscription: calendar });
      }
    }

    for (const item of workspaceCalendars[0]?.items ?? []) {
      const existing = subscriptionInfo.get(item.subscriptionId);
      if (!existing) continue;
      subscriptionInfo.set(item.subscriptionId, {
        ...existing,
        colorOverride: item.colorOverride,
      });
    }

    return subscriptionInfo;
  });

  /**
   * Events for a contiguous day range (inclusive on both ends), ready-shaped
   * as `CalendarEvent`s and sorted chronologically. Used by the sidebar's
   * Today/Tomorrow/This-Week sections.
   */
  eventsByDateRange$(rangeStart: Dayjs, rangeEnd: Dayjs) {
    return LiveData.computed((get) => {
      const subscriptionInfoById = get(this.subscriptionInfoById$);
      const eventsByDateMap = get(this.eventsByDateMap$);
      const list: CalendarEvent[] = [];
      let cursor = rangeStart.startOf("day");
      const end = rangeEnd.endOf("day");
      while (cursor.isBefore(end, "day") || cursor.isSame(end, "day")) {
        const dateKey = cursor.format("YYYY-MM-DD");
        const raw = eventsByDateMap.get(dateKey) ?? [];
        const date = cursor;
        for (const event of raw) {
          const subscriptionInfo = subscriptionInfoById.get(
            event.subscriptionId,
          );
          list.push({
            id: event.id,
            recurrenceId: event.recurrenceId,
            subscriptionId: event.subscriptionId,
            title: event.title ?? "",
            startAt: dayjs(event.startAtUtc),
            endAt: dayjs(event.endAtUtc),
            allDay: event.allDay,
            date,
            calendarName:
              subscriptionInfo?.subscription.displayName ??
              subscriptionInfo?.subscription.externalCalendarId ??
              "",
            calendarColor:
              subscriptionInfo?.colorOverride ??
              subscriptionInfo?.subscription.color ??
              undefined,
            tagId: event.tagId,
          } satisfies CalendarEvent);
        }
        cursor = cursor.add(1, "day");
      }
      list.sort(
        (left, right) => left.startAt.valueOf() - right.startAt.valueOf(),
      );
      return list;
    });
  }

  eventsByDate$(date: Dayjs) {
    const dateKey = date.format("YYYY-MM-DD");
    return LiveData.computed((get) => {
      const subscriptionInfoById = get(this.subscriptionInfoById$);
      const eventsByDateMap = get(this.eventsByDateMap$);
      const events = eventsByDateMap.get(dateKey) ?? [];

      return events
        .map((event) => {
          const subscriptionInfo = subscriptionInfoById.get(
            event.subscriptionId,
          );
          return {
            id: event.id,
            recurrenceId: event.recurrenceId,
            subscriptionId: event.subscriptionId,
            title: event.title ?? "",
            startAt: dayjs(event.startAtUtc),
            endAt: dayjs(event.endAtUtc),
            allDay: event.allDay,
            date,
            calendarName:
              subscriptionInfo?.subscription.displayName ??
              subscriptionInfo?.subscription.externalCalendarId ??
              "",
            calendarColor:
              subscriptionInfo?.colorOverride ??
              subscriptionInfo?.subscription.color ??
              undefined,
            tagId: event.tagId,
          } satisfies CalendarEvent;
        })
        .sort(
          (left, right) => left.startAt.valueOf() - right.startAt.valueOf(),
        );
    });
  }

  async loadAccountCalendars(signal?: AbortSignal) {
    const accounts = await this.store.fetchAccounts(signal);
    this.accounts$.setValue(accounts);

    const calendarsByAccount = new Map<
      string,
      NonNullable<
        NonNullable<
          CalendarAccountsQuery["currentUser"]
        >["calendarAccounts"][number]
      >["calendars"]
    >();

    accounts.forEach((account) => {
      calendarsByAccount.set(account.id, account.calendars ?? []);
    });

    this.accountCalendars$.setValue(calendarsByAccount);
    return calendarsByAccount;
  }

  async revalidateWorkspaceCalendars(signal?: AbortSignal) {
    const calendars = await this.store.fetchWorkspaceCalendars(signal);
    this.workspaceCalendars$.setValue(calendars);
    return calendars;
  }

  async updateWorkspaceCalendars(items: WorkspaceCalendarItemInput[]) {
    const updated = await this.store.updateWorkspaceCalendars(items);
    const next = [...this.workspaceCalendars$.value];
    const index = next.findIndex((calendar) => calendar.id === updated.id);
    if (index >= 0) {
      next[index] = updated;
    } else {
      next.push(updated);
    }
    this.workspaceCalendars$.setValue(next);
    return updated;
  }

  async revalidateEventsRange(
    rangeStart: Dayjs,
    rangeEnd: Dayjs,
    signal?: AbortSignal,
  ) {
    const start = rangeStart.startOf("day");
    const end = rangeEnd.endOf("day");
    this.activeRange = { start, end };
    const generation = this.eventsGeneration;
    const workspaceCalendarId = this.workspaceCalendars$.value[0]?.id;
    const next = new Map(this.eventsByDateMap$.value);
    let cursor = start;
    while (cursor.isBefore(end, "day") || cursor.isSame(end, "day")) {
      next.set(cursor.format("YYYY-MM-DD"), []);
      cursor = cursor.add(1, "day");
    }
    if (!workspaceCalendarId) {
      this.eventsByDateMap$.setValue(next);
      return [];
    }

    const events = await this.store.fetchEvents(
      workspaceCalendarId,
      start.toISOString(),
      end.toISOString(),
      signal,
    );
    if (generation !== this.eventsGeneration) return events;
    for (const event of events) {
      const startAt = dayjs(event.startAtUtc);
      const endAt = dayjs(event.endAtUtc);
      let current = startAt.isBefore(start, "day") ? start : startAt;
      const rangeEndDay = endAt.isAfter(end, "day") ? end : endAt;

      while (
        current.isBefore(rangeEndDay, "day") ||
        current.isSame(rangeEndDay, "day")
      ) {
        if (
          current.isSame(endAt, "day") &&
          endAt.hour() === 0 &&
          endAt.minute() === 0
        ) {
          break;
        }
        const dateKey = current.format("YYYY-MM-DD");
        const list = next.get(dateKey);
        if (list) {
          list.push(event);
        } else {
          next.set(dateKey, [event]);
        }
        current = current.add(1, "day");
      }
    }
    this.eventsByDateMap$.setValue(next);
    this.lastRevalidatedAt$.setValue(Date.now());
    return events;
  }

  async revalidateEvents(date: Dayjs, signal?: AbortSignal) {
    return await this.revalidateEventsRange(date, date, signal);
  }

  findEventDetails(eventId: string) {
    return this.eventDetailsById$.value.get(eventId) ?? null;
  }

  async resolveEventDetails(eventId: string, signal?: AbortSignal) {
    const cached = this.findEventDetails(eventId);
    if (cached) return cached;

    const generation = this.eventsGeneration;
    const event = await this.store.fetchEvent(eventId, signal);
    if (generation !== this.eventsGeneration)
      return this.findEventDetails(eventId);
    if (!event) return null;
    this._rememberEventDetails(event);
    this._ensureEventSnapshotInCache(event);
    return event;
  }

  async revalidateEventDetails(eventId: string, signal?: AbortSignal) {
    const generation = this.eventsGeneration;
    const event = await this.store.fetchEvent(eventId, signal);
    if (generation !== this.eventsGeneration)
      return this.findEventDetails(eventId);
    if (event) {
      this._rememberEventDetails(event);
      this._ensureEventSnapshotInCache(event);
      return event;
    }

    this._forgetEvent(eventId);
    return null;
  }

  async createEvent(input: Omit<CreateWorkspaceEventInput, "workspaceId">) {
    const result = await this.store.createEvent(input);
    await this._refreshAfterWrite(input.startsAt, input.endsAt);
    this._rememberEventDetails(result);
    this._ensureEventSnapshotInCache(result);
    return result;
  }

  async updateEvent(
    eventId: string,
    scope: NativeEventScope,
    input: UpdateWorkspaceEventInput,
    instanceStart?: string,
  ) {
    const result = await this.store.updateEvent(
      eventId,
      scope,
      input,
      instanceStart,
    );
    const startsAt = input.startsAt ?? result.startsAt;
    const endsAt = input.endsAt ?? result.endsAt;
    await this._refreshAfterWrite(startsAt, endsAt);
    this._rememberEventDetails(result);
    this._ensureEventSnapshotInCache(result);
    return result;
  }

  async deleteEvent(
    eventId: string,
    scope: NativeEventScope,
    instanceStart?: string,
  ) {
    await this.store.deleteEvent(eventId, scope, instanceStart);
    await this._refreshAfterWrite();
  }

  async controlRecurrence(
    eventId: string,
    revision: number,
    action: CalendarTimingAction,
  ) {
    const event = await this.store.controlRecurrence(eventId, revision, action);
    await this._refreshAfterWrite(event.startsAt, event.endsAt);
    this._rememberEventDetails(event);
    return event;
  }

  resolveWallTime(value: string, zone: string) {
    return this.store.resolveWallTime(value, zone);
  }

  listSeries() {
    return this.store.listSeries();
  }

  async listTags(signal?: AbortSignal) {
    const tags = await this.store.fetchTags(signal);
    this.tags$.setValue(tags);
    return tags;
  }

  async createTag(input: Omit<CreateEventTagInput, "workspaceId">) {
    const tag = await this.store.createTag(input);
    this.tags$.setValue([...this.tags$.value, tag]);
    return tag;
  }

  async updateTag(
    tagId: string,
    input: Omit<UpdateEventTagInput, "workspaceId">,
  ) {
    const updated = await this.store.updateTag(tagId, input);
    this.tags$.setValue(
      this.tags$.value.map((t) => (t.id === tagId ? updated : t)),
    );
    return updated;
  }

  async deleteTag(tagId: string) {
    await this.store.deleteTag(tagId);
    this.tags$.setValue(this.tags$.value.filter((t) => t.id !== tagId));
  }

  async getSettings(signal?: AbortSignal) {
    const settings = await this.store.fetchSettings(signal);
    this.settings$.setValue(settings);
    return settings;
  }

  async updateSettings(
    input: Omit<UpdateWorkspaceCalendarSettingsInput, "workspaceId">,
  ) {
    const updated = await this.store.updateSettings(input);
    this.settings$.setValue(updated);
    return updated;
  }

  async exportIcs(from: Dayjs, to: Dayjs, signal?: AbortSignal) {
    return await this.store.exportIcs(
      from.toISOString(),
      to.toISOString(),
      signal,
    );
  }

  async importIcs(icsBody: string) {
    const result = await this.store.importIcs(icsBody);
    this.eventsByDateMap$.setValue(new Map());
    return result;
  }

  checkConflicts(
    from: Dayjs,
    to: Dayjs,
    excludeId?: string,
  ): NonNullable<
    CalendarEventsQuery["workspace"]
  >["calendars"][number]["events"][number][] {
    const start = from.toISOString();
    const end = to.toISOString();
    const allEvents: NonNullable<
      CalendarEventsQuery["workspace"]
    >["calendars"][number]["events"][number][] = [];
    for (const events of this.eventsByDateMap$.value.values()) {
      for (const event of events) {
        if (excludeId && event.id === excludeId) continue;
        const eStart = event.startAtUtc;
        const eEnd = event.endAtUtc;
        if (
          eStart < end &&
          eEnd > start &&
          !allEvents.some(
            (e) => e.id === event.id && e.recurrenceId === event.recurrenceId,
          )
        ) {
          allEvents.push(event);
        }
      }
    }
    return allEvents;
  }

  /** A confirmed write must not become a failed Save merely because its read
   * refresh failed. Fence in-flight old reads and refresh the consuming window,
   * not only a recurring master's possibly years-old DTSTART. */
  private async _refreshAfterWrite(startsAt?: string, endsAt?: string) {
    this.eventsGeneration += 1;
    this.eventDetailsById$.setValue(new Map());
    this.refreshFailed$.setValue(false);
    if (!this.workspaceCalendars$.value[0]?.id) return;
    const range =
      this.activeRange ??
      (startsAt && endsAt
        ? { start: dayjs(startsAt), end: dayjs(endsAt) }
        : null);
    this.eventsByDateMap$.setValue(new Map());
    if (!range) return;
    try {
      await this.revalidateEventsRange(range.start, range.end);
    } catch {
      this.refreshFailed$.setValue(true);
    }
  }

  private _ensureEventSnapshotInCache(event: WorkspaceEventSnapshot) {
    // Detail resolves a master, not an occurrence window. Injecting that
    // DTSTART snapshot would erase its siblings and can resurrect an exclusion.
    if (
      event.origin === CalendarEventOrigin.External ||
      event.recurrence ||
      event.recurrenceParentId
    )
      return;
    this._upsertEventSnapshot(this._toCachedEvent(event));
  }

  private _rememberEventDetails(event: WorkspaceEventSnapshot) {
    const next = new Map(this.eventDetailsById$.value);
    next.set(event.id, event);
    this.eventDetailsById$.setValue(next);
  }

  private _forgetEvent(eventId: string) {
    const details = new Map(this.eventDetailsById$.value);
    details.delete(eventId);
    this.eventDetailsById$.setValue(details);

    const events = new Map(this.eventsByDateMap$.value);
    for (const [date, entries] of events) {
      events.set(
        date,
        entries.filter((entry) => entry.id !== eventId),
      );
    }
    this.eventsByDateMap$.setValue(events);
  }

  private _toCachedEvent(event: WorkspaceEventSnapshot): CachedCalendarEvent {
    return {
      id: event.id,
      subscriptionId: event.workspaceId
        ? `${event.workspaceId}:native`
        : "workspace",
      externalEventId: event.id,
      recurrenceId: event.recurrenceParentId,
      status: null,
      title: event.title,
      description: null,
      location: null,
      startAtUtc: event.startsAt,
      endAtUtc: event.endsAt,
      originalTimezone: null,
      allDay: event.allDay,
      tagId: event.tagId,
      reminders: event.reminders,
    };
  }

  private _upsertEventSnapshot(event: CachedCalendarEvent) {
    const next = new Map(this.eventsByDateMap$.value);
    for (const [dateKey, events] of next) {
      next.set(
        dateKey,
        events.filter((cached) => cached.id !== event.id),
      );
    }

    const startAt = dayjs(event.startAtUtc);
    const endAt = dayjs(event.endAtUtc);
    let current = startAt;
    while (current.isBefore(endAt, "day") || current.isSame(endAt, "day")) {
      if (
        current.isSame(endAt, "day") &&
        endAt.hour() === 0 &&
        endAt.minute() === 0
      ) {
        break;
      }
      const dateKey = current.format("YYYY-MM-DD");
      next.set(dateKey, [...(next.get(dateKey) ?? []), event]);
      current = current.add(1, "day");
    }

    this.eventsByDateMap$.setValue(next);
  }
}
