/**
 * @vitest-environment happy-dom
 */

import { Framework, LiveData } from "@myoxus/infra";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockedFunction,
  test,
  vi,
} from "vitest";

vi.mock("@myoxus/ui-facade", () => ({
  notify: vi.fn(),
}));

// Import after vi.mock so the hoisted mock is in place.
const { notify } = await import("@myoxus/ui-facade");
const notifyMock = notify as MockedFunction<typeof notify>;

import { CalendarIntegration } from "../modules/integration/entities/calendar";
import { ReadwiseIntegration } from "../modules/integration/entities/readwise";
import { IntegrationWriter } from "../modules/integration/entities/writer";
import type { CalendarReminderDuePayload } from "../modules/integration/events/calendar";
import { IntegrationService } from "../modules/integration/services/integration";
import { CalendarReminderService } from "../modules/integration/services/reminder";
import { CalendarStore } from "../modules/integration/store/calendar";
import { WorkspaceService } from "../modules/workspace";

const WS_ID = "ws-core03-test";

function makeMockStore(): CalendarStore {
  return {
    fetchAccounts: vi.fn().mockResolvedValue([]),
    fetchWorkspaceCalendars: vi.fn().mockResolvedValue([]),
    updateWorkspaceCalendars: vi.fn(),
    fetchEvents: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    fetchTags: vi.fn().mockResolvedValue([]),
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
    fetchSettings: vi.fn().mockResolvedValue(null),
    updateSettings: vi.fn(),
    exportIcs: vi.fn().mockResolvedValue(""),
    importIcs: vi.fn(),
  } as unknown as CalendarStore;
}

function makeFramework() {
  const framework = new Framework();
  framework.service(WorkspaceService, { workspace: { id: WS_ID } } as any);
  framework.store(CalendarStore, makeMockStore());
  framework.entity(CalendarIntegration, [CalendarStore]);
  framework.entity(IntegrationWriter, () => ({}) as any);
  framework.entity(
    ReadwiseIntegration,
    () => ({ importing$: new LiveData(false) }) as any,
  );
  framework.service(IntegrationService, [WorkspaceService]);
  framework.service(CalendarReminderService, [IntegrationService]);
  return framework;
}

describe("CalendarReminderService — reminder pipeline (CORE-03)", () => {
  let BrowserNotificationMock: any;
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    notifyMock.mockClear();

    BrowserNotificationMock = vi.fn();
    BrowserNotificationMock.permission = "granted";
    vi.stubGlobal("Notification", BrowserNotificationMock);
    visibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("handleReminderDue shows in-app toast with event title", () => {
    const provider = makeFramework().provider();
    const integrationService = provider.get(IntegrationService);
    const reminderService = provider.get(CalendarReminderService);

    integrationService.calendar.eventsByDateMap$.setValue(
      new Map([
        [
          "2026-04-25",
          [
            {
              id: "evt-toast-title",
              title: "Team-Meeting",
              tagId: null,
              subscriptionId: "sub-1",
              externalEventId: "ext-1",
              recurrenceId: null,
              status: null,
              description: null,
              location: null,
              startAtUtc: "2026-04-25T10:00:00Z",
              endAtUtc: "2026-04-25T11:00:00Z",
              originalTimezone: null,
              allDay: false,
              reminders: [],
            },
          ],
        ],
      ]),
    );

    reminderService.handleReminderDue({
      eventId: "evt-toast-title",
      scheduledFor: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    expect(notifyMock).toHaveBeenCalledOnce();
    const arg = notifyMock.mock.calls[0][0] as any;
    expect(arg.title).toContain("Termin");
    expect(arg.message).toBe("Team-Meeting");
  });

  test("handleReminderDue fires browser Notification when hidden", () => {
    const provider = makeFramework().provider();
    const reminderService = provider.get(CalendarReminderService);

    reminderService.handleReminderDue({
      eventId: `evt-browser-${Date.now()}`,
      scheduledFor: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    });

    expect(BrowserNotificationMock).toHaveBeenCalledOnce();
    expect(BrowserNotificationMock.mock.calls[0][0]).toContain("Termin");
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ message: "Termin" }),
    );
  });

  test("handleReminderDue skips browser Notification when document is visible", () => {
    visibilityState = "visible";

    const provider = makeFramework().provider();
    const reminderService = provider.get(CalendarReminderService);

    reminderService.handleReminderDue({
      eventId: `evt-visible-${Date.now()}`,
      scheduledFor: new Date(Date.now() + 1 * 60 * 1000).toISOString(),
    });

    expect(BrowserNotificationMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledOnce();
  });

  test("duplicate reminder payload is ignored (dedup)", () => {
    const provider = makeFramework().provider();
    const reminderService = provider.get(CalendarReminderService);

    const uniqueId = `evt-dedup-${Date.now()}-${Math.random()}`;
    const payload: CalendarReminderDuePayload = {
      eventId: uniqueId,
      scheduledFor: "2026-04-26T09:00:00Z",
    };

    reminderService.handleReminderDue(payload);
    reminderService.handleReminderDue(payload);

    expect(notifyMock).toHaveBeenCalledOnce();
  });
});
