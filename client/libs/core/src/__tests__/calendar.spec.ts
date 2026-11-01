import { NativeEventScope } from "@myoxus/graphql";
import { Framework } from "@myoxus/infra";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { CalendarIntegration } from "../modules/integration/entities/calendar";
import { CalendarStore } from "../modules/integration/store/calendar";

function makeMockStore(): CalendarStore {
  return {
    fetchAccounts: vi.fn().mockResolvedValue([]),
    fetchWorkspaceCalendars: vi.fn().mockResolvedValue([]),
    updateWorkspaceCalendars: vi.fn(),
    fetchEvents: vi.fn().mockResolvedValue([]),
    fetchEvent: vi.fn().mockResolvedValue(null),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    fetchTags: vi.fn().mockResolvedValue([]),
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn().mockResolvedValue(undefined),
    fetchSettings: vi.fn().mockResolvedValue(null),
    updateSettings: vi.fn(),
    exportIcs: vi.fn().mockResolvedValue(""),
    importIcs: vi.fn(),
  } as unknown as CalendarStore;
}

function makeEvent(id: string, startAtUtc: string, endAtUtc: string) {
  return {
    id,
    subscriptionId: "sub-1",
    externalEventId: "",
    recurrenceId: null,
    status: null,
    title: "Test Event " + id,
    description: null,
    location: null,
    startAtUtc,
    endAtUtc,
    originalTimezone: null,
    allDay: false,
  };
}

describe("CalendarIntegration", () => {
  let mockStore: CalendarStore;
  let integration: CalendarIntegration;

  beforeEach(() => {
    mockStore = makeMockStore();

    const framework = new Framework();
    framework.store(CalendarStore, mockStore);
    framework.entity(CalendarIntegration, [CalendarStore]);
    integration = framework.provider().createEntity(CalendarIntegration);
  });

  test("createEvent calls store and updates eventsByDateMap for the event range", async () => {
    const wsCalendar = { id: "wscal-1" };
    integration.workspaceCalendars$.setValue([wsCalendar as any]);
    const event = makeEvent(
      "e1",
      "2026-04-25T10:00:00Z",
      "2026-04-25T11:00:00Z",
    );
    vi.mocked(mockStore.createEvent).mockResolvedValue(event as any);
    vi.mocked(mockStore.fetchEvents).mockResolvedValue([event] as any);

    const result = await integration.createEvent({
      title: "Test Event e1",
      startsAt: "2026-04-25T10:00:00Z",
      endsAt: "2026-04-25T11:00:00Z",
    });

    expect(result.id).toBe("e1");
    expect(mockStore.createEvent).toHaveBeenCalledOnce();
    expect(mockStore.fetchEvents).toHaveBeenCalled();
    expect(integration.eventsByDateMap$.value.has("2026-04-25")).toBe(true);
  });

  test("resolves an event by id once and reuses the local details cache", async () => {
    const event = {
      id: "event-by-id",
      origin: "workspace",
      workspaceId: "ws-1",
      title: "Referenced event",
      startsAt: "2026-04-25T10:00:00Z",
      endsAt: "2026-04-25T11:00:00Z",
      allDay: false,
      allMembers: false,
      tagId: null,
      sourceExternalId: "doc-1",
      descriptionDelta: null,
      recurrenceParentId: null,
      reminders: [],
    };
    vi.mocked(mockStore.fetchEvent).mockResolvedValue(event as any);

    await expect(integration.resolveEventDetails(event.id)).resolves.toEqual(
      event,
    );
    await expect(integration.resolveEventDetails(event.id)).resolves.toEqual(
      event,
    );

    expect(mockStore.fetchEvent).toHaveBeenCalledOnce();
    expect(integration.findEventDetails(event.id)).toEqual(event);
  });

  test("removes a deleted event from details and date caches on revalidation", async () => {
    const event = {
      id: "deleted-event",
      origin: "workspace",
      workspaceId: "ws-1",
      title: "Deleted event",
      startsAt: "2026-04-25T10:00:00Z",
      endsAt: "2026-04-25T11:00:00Z",
      allDay: false,
      allMembers: false,
      tagId: null,
      sourceExternalId: null,
      descriptionDelta: null,
      recurrenceParentId: null,
      reminders: [],
    };
    vi.mocked(mockStore.fetchEvent)
      .mockResolvedValueOnce(event as any)
      .mockResolvedValueOnce(null);
    await integration.resolveEventDetails(event.id);

    await expect(integration.revalidateEventDetails(event.id)).resolves.toBe(
      null,
    );

    expect(integration.findEventDetails(event.id)).toBeNull();
    expect(
      [...integration.eventsByDateMap$.value.values()].flat(),
    ).not.toContainEqual(expect.objectContaining({ id: event.id }));
  });

  test("createEvent seeds cache when workspace calendars are not loaded yet", async () => {
    const event = {
      id: "e-missing-calendar-cache",
      origin: "workspace",
      workspaceId: "ws-1",
      title: "Event block can render immediately",
      startsAt: "2026-04-25T10:00:00Z",
      endsAt: "2026-04-25T11:00:00Z",
      allDay: false,
      allMembers: false,
      tagId: null,
      sourceExternalId: null,
      descriptionDelta: null,
      recurrenceParentId: null,
      reminders: [],
    };
    vi.mocked(mockStore.createEvent).mockResolvedValue(event as any);

    await integration.createEvent({
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    });

    expect(mockStore.fetchEvents).not.toHaveBeenCalled();
    expect(integration.eventsByDateMap$.value.get("2026-04-25")).toContainEqual(
      expect.objectContaining({
        id: event.id,
        title: event.title,
        startAtUtc: event.startsAt,
        endAtUtc: event.endsAt,
      }),
    );
  });

  test("updateEvent calls store and triggers revalidation of affected date range", async () => {
    const wsCalendar = { id: "wscal-1" };
    integration.workspaceCalendars$.setValue([wsCalendar as any]);
    const event = makeEvent(
      "e2",
      "2026-04-25T12:00:00Z",
      "2026-04-25T13:00:00Z",
    );
    vi.mocked(mockStore.updateEvent).mockResolvedValue(event as any);
    vi.mocked(mockStore.fetchEvents).mockResolvedValue([event] as any);

    const result = await integration.updateEvent("e2", NativeEventScope.All, {
      title: "Updated",
      startsAt: "2026-04-25T12:00:00Z",
      endsAt: "2026-04-25T13:00:00Z",
    });

    expect(result.id).toBe("e2");
    expect(mockStore.updateEvent).toHaveBeenCalledWith(
      "e2",
      NativeEventScope.All,
      expect.objectContaining({ title: "Updated" }),
      undefined,
    );
    expect(mockStore.fetchEvents).toHaveBeenCalled();
    expect(integration.eventsByDateMap$.value.has("2026-04-25")).toBe(true);
  });

  test("updateEvent moves cached snapshot when workspace calendars are not loaded yet", async () => {
    const previous = makeEvent(
      "e-move-without-calendar-cache",
      "2026-04-25T12:00:00Z",
      "2026-04-25T13:00:00Z",
    );
    integration.eventsByDateMap$.setValue(
      new Map([["2026-04-25", [previous as any]]]),
    );
    const updated = {
      id: previous.id,
      origin: "workspace",
      workspaceId: "ws-1",
      title: "Moved Event",
      startsAt: "2026-04-26T12:00:00Z",
      endsAt: "2026-04-26T13:00:00Z",
      allDay: false,
      allMembers: false,
      tagId: null,
      sourceExternalId: null,
      descriptionDelta: null,
      recurrenceParentId: null,
      reminders: [],
    };
    vi.mocked(mockStore.updateEvent).mockResolvedValue(updated as any);

    await integration.updateEvent(previous.id, NativeEventScope.All, {
      startsAt: updated.startsAt,
      endsAt: updated.endsAt,
    });

    expect(mockStore.fetchEvents).not.toHaveBeenCalled();
    expect(
      integration.eventsByDateMap$.value.get("2026-04-25") ?? [],
    ).toHaveLength(0);
    expect(integration.eventsByDateMap$.value.get("2026-04-26")).toContainEqual(
      expect.objectContaining({
        id: updated.id,
        title: updated.title,
        startAtUtc: updated.startsAt,
        endAtUtc: updated.endsAt,
      }),
    );
  });

  test("deleteEvent calls store and clears eventsByDateMap", async () => {
    await integration.deleteEvent(
      "e3",
      NativeEventScope.This,
      "2026-04-25T09:00:00Z",
    );

    expect(mockStore.deleteEvent).toHaveBeenCalledWith(
      "e3",
      NativeEventScope.This,
      "2026-04-25T09:00:00Z",
    );
    expect(integration.eventsByDateMap$.value.size).toBe(0);
  });

  test("listTags fetches and updates tags$ LiveData", async () => {
    const tags = [
      {
        id: "t1",
        workspaceId: "ws",
        name: "Work",
        color: "#ff0000",
        createdAt: "",
        updatedAt: "",
      },
    ];
    vi.mocked(mockStore.fetchTags).mockResolvedValue(tags as any);

    await integration.listTags();

    expect(integration.tags$.value).toHaveLength(1);
    expect(integration.tags$.value[0].id).toBe("t1");
  });

  test("createTag adds to tags$ LiveData", async () => {
    const tag = {
      id: "t2",
      workspaceId: "ws",
      name: "Personal",
      color: "#00ff00",
      createdAt: "",
      updatedAt: "",
    };
    vi.mocked(mockStore.createTag).mockResolvedValue(tag as any);

    const result = await integration.createTag({
      name: "Personal",
      color: "#00ff00",
    });

    expect(result.id).toBe("t2");
    expect(integration.tags$.value.some((t) => t.id === "t2")).toBe(true);
  });

  test("updateTag updates entry in tags$ LiveData", async () => {
    const initial = {
      id: "t3",
      workspaceId: "ws",
      name: "Old",
      color: "#aaa",
      createdAt: "",
      updatedAt: "",
    };
    integration.tags$.setValue([initial as any]);
    const updated = { ...initial, name: "New" };
    vi.mocked(mockStore.updateTag).mockResolvedValue(updated as any);

    await integration.updateTag("t3", { name: "New" });

    expect(integration.tags$.value[0].name).toBe("New");
  });

  test("deleteTag removes from tags$ LiveData", async () => {
    const tag = {
      id: "t4",
      workspaceId: "ws",
      name: "Gone",
      color: "#fff",
      createdAt: "",
      updatedAt: "",
    };
    integration.tags$.setValue([tag as any]);

    await integration.deleteTag("t4");

    expect(integration.tags$.value).toHaveLength(0);
  });

  test("getSettings fetches and updates settings$ LiveData", async () => {
    const settings = {
      workspaceId: "ws",
      writebackSubscriptionId: null,
      defaultReminderOffsetMinutes: 15,
      updatedAt: "",
    };
    vi.mocked(mockStore.fetchSettings).mockResolvedValue(settings as any);

    await integration.getSettings();

    expect(integration.settings$.value?.defaultReminderOffsetMinutes).toBe(15);
  });

  test("updateSettings updates settings$ LiveData", async () => {
    const updated = {
      workspaceId: "ws",
      writebackSubscriptionId: null,
      defaultReminderOffsetMinutes: 30,
      updatedAt: "",
    };
    vi.mocked(mockStore.updateSettings).mockResolvedValue(updated as any);

    await integration.updateSettings({ defaultReminderOffsetMinutes: 30 });

    expect(integration.settings$.value?.defaultReminderOffsetMinutes).toBe(30);
  });

  test("importIcs calls store and clears eventsByDateMap", async () => {
    const result = { importedCount: 3, skippedCount: 0, errors: [] };
    vi.mocked(mockStore.importIcs).mockResolvedValue(result as any);

    const res = await integration.importIcs("BEGIN:VCALENDAR...");

    expect(res.importedCount).toBe(3);
    expect(mockStore.importIcs).toHaveBeenCalledWith("BEGIN:VCALENDAR...");
    expect(integration.eventsByDateMap$.value.size).toBe(0);
  });

  test("checkConflicts returns overlapping events from in-memory map", async () => {
    const e1 = makeEvent(
      "e-c1",
      "2026-04-25T10:00:00Z",
      "2026-04-25T12:00:00Z",
    );
    const e2 = makeEvent(
      "e-c2",
      "2026-04-25T14:00:00Z",
      "2026-04-25T16:00:00Z",
    );
    integration.eventsByDateMap$.setValue(
      new Map([["2026-04-25", [e1 as any, e2 as any]]]),
    );

    const dayjs = (await import("dayjs")).default;
    const conflicts = integration.checkConflicts(
      dayjs("2026-04-25T09:00:00Z"),
      dayjs("2026-04-25T11:00:00Z"),
    );

    expect(conflicts.map((e) => e.id)).toContain("e-c1");
    expect(conflicts.map((e) => e.id)).not.toContain("e-c2");
  });

  test("checkConflicts excludes given eventId", async () => {
    const e = makeEvent(
      "e-excl",
      "2026-04-25T10:00:00Z",
      "2026-04-25T12:00:00Z",
    );
    integration.eventsByDateMap$.setValue(
      new Map([["2026-04-25", [e as any]]]),
    );

    const dayjs = (await import("dayjs")).default;
    const conflicts = integration.checkConflicts(
      dayjs("2026-04-25T09:00:00Z"),
      dayjs("2026-04-25T11:00:00Z"),
      "e-excl",
    );

    expect(conflicts).toHaveLength(0);
  });
});
